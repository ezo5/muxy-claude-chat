#!/usr/bin/env python3
import fcntl, json, os, signal, subprocess, sys, time, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import agent_tracker, config, ledger, logpage, procs, protocol
import state as S
import blob, hello, kv, projects, reader, requests, sound, tui, watch
from reader import transcript

DAEMON = os.path.join(HERE, "daemon.py")
PERMISSION_MODES = {"acceptEdits", "auto", "bypassPermissions", "manual", "default", "dontAsk", "plan"}


def daemon_marker(d):
    return os.path.basename(DAEMON) + " " + d


def daemon_alive(d, st):
    return procs.alive(st.get("pid"), daemon_marker(d), st.get("pidStarted"))


def cli_alive(st):
    return procs.alive(st.get("cliPid"), st.get("cliMarker"), st.get("cliPidStarted"))


def locked(d):
    lock = open(os.path.join(d, "lock"), "w")
    fcntl.flock(lock, fcntl.LOCK_EX)
    return lock


# A daemon gone without its `stopped` event is repaired here, under the session lock so two ops never both write it.
def load_state(d, have_lock=False):
    st = S.read_state(d)
    if st is None:
        return None
    if st.get("status") != "stopped" and not daemon_alive(d, st):
        lock = None if have_lock else locked(d)
        try:
            st = S.read_state(d) or st
            if st.get("status") != "stopped" and not daemon_alive(d, st):
                if cli_alive(st):
                    os.kill(int(st["cliPid"]), signal.SIGTERM)
                seq = S.last_seq(d) + 1
                S.append_event(d, seq, {"type": "daemon", "subtype": "stopped", "reason": "dead", "exitCode": None})
                st.update({"status": "stopped", "reason": "dead", "pid": None, "cliPid": None, "pending": [], "promptQueue": [],
                           "turn": {"startedAt": None, "promptId": None}, "stoppedAt": S.now_ms(), "lastSeq": seq})
                S.write_state(d, st)
        finally:
            if lock is not None:
                lock.close()
    st["lastSeq"] = max(int(st.get("lastSeq") or 0), S.last_seq(d))
    return st


def session(req):
    d = config.session_dir(req.get("sessionId") or "")
    if not os.path.isdir(d):
        raise SystemExit("unknown session %s" % req.get("sessionId"))
    return d


def running(req):
    d = session(req)
    st = load_state(d)
    if not st or st.get("status") == "stopped":
        raise SystemExit("session not running")
    if st.get("status") == "stopping":
        raise SystemExit("session is stopping")
    return d, st


# A fork at a message (`resumeAt`) stays pending until the CLI writes the forked transcript (its first prompt), so a
# restart before that forks again instead of starting an empty conversation.
def fork_source(req, prev, cwd, cli_sid):
    if req.get("forkSession") and req.get("resumeAt") and req.get("cliSessionId"):
        return {"cliSessionId": req["cliSessionId"], "resumeAt": req["resumeAt"]}
    pending = prev.get("forkFrom")
    if pending and not req.get("cliSessionId") and not os.path.isfile(tui.transcript_path(cwd, cli_sid)):
        return pending
    return None


def op_start(req):
    cwd = req.get("cwd") or ""
    sid = req.get("sessionId") or str(uuid.uuid4())
    d = config.session_dir(sid)
    os.makedirs(d, exist_ok=True)
    with locked(d):
        st = load_state(d, have_lock=True)
        if st and st.get("status") != "stopped":
            return {"sessionId": sid, "pid": st.get("pid"), "started": False}
        if not os.path.isdir(cwd):
            raise SystemExit("cwd not found: %s" % cwd)
        if not config.claude_bin():
            raise SystemExit("claude binary not found (PATH, ~/.local/bin/claude or config claudeBin)")
        prev = st or {}
        cli_sid = req.get("cliSessionId") or prev.get("cliSessionId") or sid
        resume = req.get("resume")
        if resume is None:
            resume = bool(prev.get("lastSeq"))
        if resume:
            tui.adopt_transcript(os.path.abspath(cwd), cli_sid)
        # --resume of a conversation the CLI never wrote loops on "No conversation found": start fresh under the same id
        if resume and not os.path.isfile(tui.transcript_path(os.path.abspath(cwd), cli_sid)):
            resume = False
        fork_from = fork_source(req, prev, os.path.abspath(cwd), cli_sid)
        if fork_from:
            cli_sid, resume = fork_from["cliSessionId"], True
        # After a stretch in a terminal the transcript has turns this log doesn't: the view rebuilds from the transcript.
        S.rotate_events(d, limit=-1) if req.get("freshEvents") else S.rotate_events(d)
        args = {"sessionId": sid, "cliSessionId": cli_sid, "cwd": os.path.abspath(cwd), "resume": bool(resume),
                "fork": bool(req.get("forkSession") or fork_from), "forkFrom": fork_from, "partial": req.get("partial", True) is not False,
                "model": req.get("model") or (prev.get("model") if resume else None),
                "effort": req.get("effort") or (prev.get("effort") if resume else None),
                "permissionMode": req.get("permissionMode") or (prev.get("permissionMode") if resume and prev.get("permissionMode") in PERMISSION_MODES else None),
                "pluginDirs": req.get("pluginDirs") or prev.get("pluginDirs"), "addDirs": req.get("addDirs") or prev.get("addDirs"),
                "appendSystemPromptFile": req.get("appendSystemPromptFile") or prev.get("appendSystemPromptFile")}
        with open(os.path.join(d, "daemon.log"), "ab") as log:
            p = subprocess.Popen([sys.executable, DAEMON, d, json.dumps(args)], cwd=args["cwd"], stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                 start_new_session=True, close_fds=True)
        deadline = time.time() + 10
        while time.time() < deadline:
            st = S.read_state(d)
            if st and st.get("pid") == p.pid:
                return {"sessionId": sid, "pid": p.pid, "started": True, "resumed": bool(resume)}
            if p.poll() is not None:
                break
            time.sleep(0.05)
        raise SystemExit("daemon did not start: " + tail(os.path.join(d, "daemon.log")))


def tail(path, n=1500):
    try:
        with open(path, "rb") as fh:
            fh.seek(0, 2)
            fh.seek(max(0, fh.tell() - n))
            return fh.read().decode("utf-8", "replace").strip()
    except OSError:
        return ""


def op_stop(req):
    d = session(req)
    st = load_state(d)
    if not st or st.get("status") == "stopped":
        prune(d, st)
        return {"ok": True, "id": None}
    rid = S.append_inbox(d, {"type": "stop", "force": bool(req.get("force"))})
    if req.get("force") and daemon_alive(d, st):
        os.kill(int(st["pid"]), signal.SIGTERM)
    return {"ok": True, "id": rid}


# Stopped sessions only: the consumed part of the inbox (base64 images) goes; the daemon does the same when it exits.
def prune(d, st):
    if not st or st.get("status") != "stopped":
        return {"ok": False, "inboxBytes": None}
    with locked(d):
        st = S.read_state(d) or st
        if st.get("status") != "stopped":
            return {"ok": False, "inboxBytes": None}
        kept = S.prune_inbox(d, int(st.get("inboxOffset") or 0))
        if st.get("inboxOffset"):
            st["inboxOffset"] = 0
            S.write_state(d, st)
    return {"ok": True, "inboxBytes": kept}


def op_prune(req):
    d = session(req)
    return prune(d, load_state(d))


def op_send(req):
    d, _ = running(req)
    cmd = {"type": "prompt", "text": req.get("text") or "", "clientId": req.get("clientId")}
    if req.get("images"):
        cmd["images"] = req["images"]
    return {"id": S.append_inbox(d, cmd)}


def op_send_chunk(req):
    d, _ = running(req)
    return {"id": S.append_inbox(d, {"type": "prompt_chunk", "chunkId": req.get("chunkId"), "index": int(req.get("index") or 0),
                                     "total": int(req.get("total") or 1), "data": req.get("data") or ""})}


def op_respond(req):
    d, _ = running(req)
    cmd = {"type": "respond", "requestId": req.get("requestId"), "behavior": req.get("behavior") or "deny"}
    for k in ("updatedInput", "updatedPermissions", "message"):
        if req.get(k) is not None:
            cmd[k] = req[k]
    return {"id": S.append_inbox(d, cmd)}


def op_interrupt(req):
    d, _ = running(req)
    return {"id": S.append_inbox(d, {"type": "interrupt"})}


def op_control(req):
    d, _ = running(req)
    cmd = {k: v for k, v in req.items() if k not in ("op", "sessionId")}
    cmd["type"] = "control"
    if not cmd.get("subtype"):
        raise SystemExit("control needs subtype")
    return {"id": S.append_inbox(d, cmd)}


def state_or_stub(d, sid):
    return load_state(d) or {"sessionId": sid, "status": "stopped", "version": 0, "lastSeq": 0, "pending": []}


# Written by the optional claude-pane-title hook: a topic that follows the conversation.
def topic_path(st):
    sid = st.get("cliSessionId") or st.get("sessionId") or ""
    return os.path.join(os.path.expanduser("~"), ".cache", "claude-pane-title", sid + ".json")


def topic_mtime(st):
    try:
        return os.stat(topic_path(st)).st_mtime
    except OSError:
        return 0


def with_topic(res, st):
    at = topic_mtime(st)
    if at > 0:
        res["topic"] = (S.read_json(topic_path(st)) or {}).get("topic")
        res["topicAt"] = at
    return res


def op_events(req):
    d = session(req)
    tail = S.last_seq(d)
    events, more = S.read_events(d, int(req.get("after") or 0), int(req.get("limit") or 500))
    st = state_or_stub(d, req.get("sessionId"))
    # the cursor must not run ahead of what was returned: events may land between the read and the state load
    return with_topic({"events": events, "lastSeq": events[-1]["seq"] if events else tail, "state": st, "more": more}, st)


def op_log_tail(req):
    d = session(req)
    res = logpage.tail(os.path.join(d, "events.jsonl"))
    st = S.read_state(d) or {}
    if res["start"] > 0 and st.get("cwd") and st.get("cliSessionId"):
        res["meta"] = transcript.tail_meta(tui.transcript_path(st["cwd"], st["cliSessionId"]))
    return res


def op_log_older(req):
    return logpage.older(os.path.join(session(req), "events.jsonl"), int(req.get("before") or 0))


def op_wait(req):
    d = session(req)
    after = int(req.get("after") or 0)
    version = int(req.get("stateVersion") or 0)
    deadline = time.time() + min(int(req.get("timeoutMs") or 25000), 25000) / 1000.0
    topic_at = float(req.get("topicAt") or 0)
    path = os.path.join(d, "state.json")
    while True:
        tail = S.last_seq(d)
        st = S.read_json(path) or {"sessionId": req.get("sessionId")}
        if tail > after or int(st.get("version") or 0) > version or topic_mtime(st) > topic_at:
            return op_events(req)
        if time.time() >= deadline:
            st = state_or_stub(d, req.get("sessionId"))
            return with_topic({"events": [], "lastSeq": tail, "state": st, "more": False}, st)
        time.sleep(0.08)


def op_state(req):
    d = config.session_dir(req.get("sessionId") or "")
    if not os.path.isdir(d):
        raise SystemExit("unknown session %s" % req.get("sessionId"))
    return state_or_stub(d, req.get("sessionId"))


def agent_rows(st):
    rows = st.get("agents") if isinstance(st.get("agents"), list) else []
    return agent_tracker.settle(rows, st.get("status") != "stopped", (st.get("startedAt") or 0) / 1000.0)


RUNNING_MAX = 20


def running_agents(rows):
    # the sidebar's "N agents" line: running subagents only (no background commands)
    out = [{k: r.get(k) for k in ("id", "parent", "agentId", "description", "type", "startTs")}
           for r in rows if r.get("kind") == "agent" and r.get("status") == "running"]
    return out[:RUNNING_MAX]


def list_row(sid, st):
    rows = agent_rows(st)
    return {"sessionId": sid, "cwd": st.get("cwd"), "status": st.get("status"), "pid": st.get("pid"), "lastSeq": st.get("lastSeq"),
            "updatedAt": st.get("updatedAt"), "model": st.get("model"), "reason": st.get("reason"), "cliSessionId": st.get("cliSessionId"),
            "lastSkill": st.get("lastSkill"), "agents": agent_tracker.counts(rows), "title": st.get("title"),
            "preview": st.get("preview") or {}, "cost": ((st.get("spend") or {}).get("total") or {}).get("cost"),
            "running": running_agents(rows)}


def op_list(req):
    out = []
    try:
        names = os.listdir(config.SESSIONS)
    except OSError:
        names = []
    for sid in names:
        d = os.path.join(config.SESSIONS, sid)
        st = load_state(d)
        if not st or (req.get("cwd") and st.get("cwd") != req["cwd"]):
            continue
        out.append(list_row(sid, st))
    out.sort(key=lambda s: -(s["updatedAt"] or 0))
    res = {"sessions": out}
    if req.get("activity"):
        res["activity"] = sound.activity()
    return res


def op_btw(req):
    cwd = os.path.abspath(req.get("cwd") or "")
    if not os.path.isdir(cwd):
        raise SystemExit("cwd not found: %s" % cwd)
    claude = config.claude_bin()
    if not claude:
        raise SystemExit("claude binary not found (PATH, ~/.local/bin/claude or config claudeBin)")
    sid = req.get("cliSessionId")
    resume = sid if sid and os.path.isfile(tui.transcript_path(cwd, sid)) else None
    try:
        p = subprocess.run(protocol.btw_argv(claude, resume, req.get("model")), cwd=cwd, input=req.get("question") or "", capture_output=True,
                           text=True, timeout=float(req.get("timeoutS") or 170))
    except subprocess.TimeoutExpired:
        raise SystemExit("no answer in time")
    try:
        r = json.loads(p.stdout)
    except ValueError:
        raise SystemExit((p.stderr or p.stdout or "").strip()[-500:] or "claude exited with %d" % p.returncode)
    if r.get("is_error"):
        raise SystemExit(str(r.get("result") or r.get("subtype") or "side question failed"))
    return {"text": r.get("result") or "", "cost": r.get("total_cost_usd"), "ms": r.get("duration_ms"), "resumed": resume is not None}


# Chats without a title in the ledger take the session's current one (/rename), else the pane-title topic.
def chat_title(sid):
    if not config.SID_RE.match(sid or ""):
        return None
    st = S.read_json(os.path.join(config.SESSIONS, sid, "state.json"))
    if not isinstance(st, dict):
        return None
    return st.get("title") or (S.read_json(topic_path(st)) or {}).get("topic")


def op_ledger(req):
    res = ledger.aggregate(req.get("days") or ledger.DAYS_DEFAULT)
    for c in res["chats"]:
        t = c.get("title") or chat_title(c["key"])
        if isinstance(t, str) and t:
            c["label"] = t[:ledger.TEXT_MAX]
    return res


OPS = {"start": op_start, "stop": op_stop, "send": op_send, "sendChunk": op_send_chunk, "respond": op_respond, "interrupt": op_interrupt,
       "control": op_control, "events": op_events, "wait": op_wait, "state": op_state, "list": op_list, "prune": op_prune, "btw": op_btw,
       "ledger": op_ledger, "logTail": op_log_tail, "logOlder": op_log_older}
OPS.update(tui.OPS)
OPS["sound"] = sound.op_sound
OPS.update(kv.OPS)
OPS.update(blob.OPS)
OPS.update(requests.OPS)
OPS.update(projects.OPS)
OPS["hello"] = hello.op_hello
OPS["watch"] = lambda req: watch.op_watch(req, sys.modules[__name__])
OPS.update(reader.OPS)
OPS["wait"] = lambda req: reader.wait(req) if "watch" in req else op_wait(req)  # both have a `wait`; only the reader's takes `watch`


def main(req=None):
    try:
        if req is None:
            req = json.load(sys.stdin)
        op = OPS.get(req.get("op"))
        if not op:
            raise SystemExit("unknown op %r" % req.get("op"))
        print(json.dumps(op(req), ensure_ascii=False))
    except SystemExit as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
