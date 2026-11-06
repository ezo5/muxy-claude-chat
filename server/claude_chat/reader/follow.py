"""Following one transcript: `poll`, `wait` and the hook state of a terminal-mode TUI."""
import json, os, re, time

from .agents import agent_status, daemon_agent_status, daemon_state_path, inline_threads
from .common import CLAUDE, SESSIONS, STATE, alive, file_size, mtime, project_dir
from .sessions import live_sessions, session_topic
from .transcript import TAIL, dead_uuids, head_meta, parse, read_range

CHUNK = 2500000


def pick_session(req, res):
    cwd = req.get("cwd") or ""
    # pinned follow: one TUI by pid (survives /clear) or Claude session id, else the given file
    if req.get("pid") or req.get("sessionId") or req.get("pinned"):
        live = live_sessions(None)
        chosen = next((c for c in live if c["pid"] == req.get("pid")), None) if req.get("pid") else None
        if chosen is None and req.get("sessionId"):
            chosen = next((c for c in live if c.get("sessionId") == req["sessionId"]), None)
        res["how"] = "pinned"
        if chosen is not None:
            return chosen, os.path.join(project_dir(chosen["cwd"]), chosen["sessionId"] + ".jsonl")
        if req.get("file"):
            return None, req["file"]
        return None, os.path.join(project_dir(cwd), req["sessionId"] + ".jsonl") if req.get("sessionId") else None
    raise SystemExit("poll needs a pinned transcript (pid / sessionId / file)")


def agent_file(f):
    if "#" in (f or ""):
        main = f.split("#")[0]
        if not main.endswith(".jsonl") or not os.path.realpath(main).startswith(os.path.realpath(os.path.join(CLAUDE, "projects")) + os.sep):
            raise SystemExit("not a transcript")
        return f
    if not re.fullmatch(r"agent-[A-Za-z0-9_-]+\.jsonl", os.path.basename(f or "")) or os.path.basename(os.path.dirname(f)) != "subagents":
        raise SystemExit("not a subagent transcript")
    return f


# Inline subagent (old transcripts): the whole thread is parsed again whenever the main transcript grows.
def poll_inline(req, res, ref):
    main, root = ref.split("#", 1)
    size = file_size(main)
    res["watch"] = {"file": main, "size": size, "dir": None, "pid": None, "state": None}
    res["offset"], res["start"] = size, 0
    if req.get("file") == ref and req.get("offset") == size:
        return res
    with open(main, "rb") as fh:
        t = inline_threads(fh.read().splitlines()).get(root)
    res["reset"] = True
    res["items"] = parse(t["lines"] if t else [], res["meta"], True)
    return res


def pid_state(pid):
    try:
        with open(os.path.join(SESSIONS, "%d.json" % pid)) as fh:
            s = json.load(fh)
    except Exception:
        return None
    return [s.get("sessionId"), s.get("status"), s.get("waitingFor")]


def op_poll(req):
    res = {"items": [], "meta": {}, "how": None}
    sessions_mtime = mtime(SESSIONS)
    sidechain = req.get("agentFile") is not None
    if sidechain:
        chosen, path = None, agent_file(req["agentFile"])
        res["agentStatus"] = agent_status(path, req.get("daemon"))
        if "#" in path:
            res["session"], res["file"] = None, path
            return poll_inline(req, res, path)
    else:
        chosen, path = pick_session(req, res)
    res["session"] = chosen
    res["file"] = path
    res["watch"] = {
        "file": path, "size": file_size(path) if path else None, "dir": sessions_mtime,
        "pid": chosen["pid"] if chosen else None,
        "state": [chosen.get("sessionId"), chosen.get("status"), chosen.get("waitingFor")] if chosen else None,
    }
    hooks = None if sidechain else hooks_events(req.get("hooks"))
    if hooks:
        res["hooks"] = hook_state(hooks, chosen["pid"] if chosen else None)
        res["watch"]["hooks"] = [hooks, file_size(hooks)]
    task_state = daemon_state_path(req.get("daemon")) if sidechain and "#" not in path else None
    if task_state:
        agent_id = os.path.basename(path)[6:-6]
        res["watch"]["task"] = [task_state, agent_id, daemon_agent_status(task_state, agent_id), mtime(task_state)]
    if path is None or not os.path.exists(path):
        res["offset"] = 0
        res["start"] = 0
        return res
    size = res["watch"]["size"]
    lines = None
    if req.get("file") == path and isinstance(req.get("offset"), int) and req["offset"] <= size:
        start = req["offset"]
        lines, start, end = read_range(path, start, min(size, start + CHUNK), False)
        if any(b'"rewound":true' in line for line in lines):
            lines = None
    dead = ()
    if lines is None:
        start = max(0, size - int(req.get("tail") or TAIL))
        lines, start, end = read_range(path, start, size, True)
        res["start"] = start
        res["reset"] = True
        if start > 0:
            res["meta"] = head_meta(path)
        if not sidechain:
            dead = dead_uuids(path)
    res["items"] = parse(lines, res["meta"], sidechain, dead)
    if not sidechain:
        topic = session_topic(os.path.basename(path)[:-len(".jsonl")])
        if topic:
            res["meta"]["topic"] = topic
    res["offset"] = end
    res["more"] = end < size - 1 and len(lines) > 0 and req.get("file") == path
    return res


# What differs from the `watch` of the last poll, else None. One look, no waiting; a task status check updates `watch`.
def changed(w):
    task = w.get("task")
    if w.get("file") and file_size(w["file"]) != w.get("size"):
        return "file"
    if w.get("hooks") and file_size(w["hooks"][0]) != w["hooks"][1]:
        return "hooks"
    if task and mtime(task[0]) != task[3]:
        task[3] = mtime(task[0])
        if daemon_agent_status(task[0], task[1]) != task[2]:
            return "task"
    if w.get("pid"):
        if not alive(w["pid"]) or pid_state(w["pid"]) != w.get("state"):
            return "session"
    elif mtime(SESSIONS) != w.get("dir"):
        return "sessions"
    return None


# Long poll: returns once the transcript or the Claude session file differs from what the last poll saw.
def op_wait(req):
    w = req.get("watch") or {}
    deadline = time.time() + min(int(req.get("timeoutMs") or 25000), 28000) / 1000.0
    while time.time() < deadline:
        what = changed(w)
        if what:
            return {"changed": what}
        time.sleep(0.15)
    return {"changed": None}


HOOKS = os.path.join(STATE, "hooks")
HOOK_ID_RE = re.compile(r"^[0-9]{1,20}-[0-9]{1,10}$")


# A terminal-mode TUI's hook dir (cli `tuiHooks`, server/claude_chat/hooks.py) → its events file; only under HOOKS.
def hooks_events(d):
    if not isinstance(d, str) or not d:
        return None
    d = os.path.normpath(d)
    return os.path.join(d, "events") if os.path.dirname(d) == HOOKS else None


# Status and open permission requests of the TUI `pid` (else the newest TUI that wrote). `at` dates the status: an
# Esc interrupt runs no hook, so a newer `idle` in the session file wins then.
def hook_state(path, pid):
    try:
        with open(path, "rb") as fh:
            fh.seek(0, 2)
            fh.seek(max(0, fh.tell() - 2000000))
            lines = fh.read().splitlines()
    except OSError:
        return None
    recs = []
    for line in lines:
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if isinstance(rec, dict):
            recs.append(rec)
    if pid is None:
        pid = next((r.get("cli") for r in reversed(recs) if r.get("e") != "_done"), None)
    status, at, reqs = None, 0, {}
    for rec in recs:
        if rec.get("cli") != pid:
            continue
        e = rec.get("e")
        if e == "_done":
            reqs.pop(rec.get("id"), None)
            continue
        if e == "PermissionRequest":
            reqs[rec.get("id")] = rec
        status = "idle" if e in ("Stop", "StopFailure", "SessionEnd") else "busy"
        at = rec.get("ts") or 0
    pending = [{"requestId": r["id"], "ts": r.get("ts"), "request": {"tool_name": r.get("tool"), "input": r.get("input") or {},
                "permission_suggestions": r.get("suggestions") or []}} for r in reqs.values() if isinstance(r.get("pid"), int) and alive(r["pid"])]
    if status is None:
        return None
    return {"status": "waiting" if pending else status, "at": at, "pending": pending}


def op_hook_respond(req):
    path = hooks_events(req.get("dir"))
    rid = str(req.get("id") or "")
    if path is None or not HOOK_ID_RE.match(rid):
        raise SystemExit("bad hook request")
    decision = {"behavior": "allow" if req.get("behavior") == "allow" else "deny"}
    for k in ("updatedInput", "updatedPermissions", "message"):
        if req.get(k) is not None:
            decision[k] = req[k]
    d = os.path.dirname(path)
    tmp = os.path.join(d, ".resp-" + rid)
    with open(tmp, "w") as fh:
        json.dump({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": decision}}, fh)
    os.replace(tmp, os.path.join(d, "resp-" + rid))
    return {"ok": True}
