import base64, glob, json, os, re, shutil, subprocess, sys, time

# build.py swaps these two lines for the module source: READER_SRC runs as `python3 -c`, without files next to it.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server", "claude_chat"))
import agent_tracker as tracker

HOME = os.path.expanduser("~")
CLAUDE = os.path.join(HOME, ".claude")
STATE = os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.join(HOME, ".cache"), "claude-chat")
CONFIG = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.join(HOME, ".config"), "claude-chat", "config.json")
SESSIONS = os.path.join(CLAUDE, "sessions")
TAIL = 1500000
CHUNK = 2500000
CLIP = 12000
IMAGE_CHUNK = 3000000
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
CMD_RE = re.compile(r"<command-name>(.*?)</command-name>", re.S)
ARGS_RE = re.compile(r"<command-args>(.*?)</command-args>", re.S)
PASTED_RE = re.compile(r'\s*</?pasted_content(?:\s+id="[^"]*")?>[ \t]*\n?')
STDOUT_RE = re.compile(r"<local-command-(stdout|stderr)>(.*?)</local-command-\1>", re.S)
TASK_RE = re.compile(r"<task-notification>.*?<summary>(.*?)</summary>.*?</task-notification>", re.S)
STATUS_RE = re.compile(r"<status>(.*?)</status>")
HANDBACK_POINTER = "(its SubagentHandback call)"


def clip(s, n=CLIP):
    s = s if isinstance(s, str) else json.dumps(s, ensure_ascii=False)
    return s if len(s) <= n else s[:n] + "\n… (" + str(len(s) - n) + " more chars)"


def project_dir(cwd):
    return os.path.join(CLAUDE, "projects", re.sub(r"[^A-Za-z0-9]", "-", cwd))


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except Exception:
        return False


def muxy_session_id(pid):
    try:
        with open("/proc/%d/environ" % pid, "rb") as fh:
            env = fh.read().split(b"\0")
    except Exception:
        return None
    for kv in env:
        if kv.startswith(b"MUXY_SESSION_ID="):
            return kv.split(b"=", 1)[1].decode() or None
    return None


def live_sessions(cwd):
    out = []
    for f in glob.glob(os.path.join(SESSIONS, "*.json")):
        try:
            with open(f) as fh:
                s = json.load(fh)
        except Exception:
            continue
        pid = s.get("pid")
        if not isinstance(pid, int) or (cwd is not None and s.get("cwd") != cwd) or s.get("kind", "interactive") != "interactive":
            continue
        if not alive(pid):
            continue
        out.append({
            "pid": pid, "sessionId": s.get("sessionId"), "cwd": s.get("cwd"), "name": s.get("name"), "status": s.get("status"),
            "waitingFor": s.get("waitingFor"), "startedAt": s.get("startedAt"), "updatedAt": s.get("updatedAt") or 0,
            "version": s.get("version"), "muxySessionId": muxy_session_id(pid),
        })
    out.sort(key=lambda s: -s["updatedAt"])
    return out


def norm(s):
    return re.sub(r"[\s─-╿>│❯]+", "", s or "")


def recent_prompts(session_ids, limit=4):
    found = {sid: [] for sid in session_ids}
    path = os.path.join(CLAUDE, "history.jsonl")
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            fh.seek(max(0, size - 600000))
            lines = fh.read().splitlines()
    except Exception:
        return found
    for line in reversed(lines):
        try:
            e = json.loads(line)
        except Exception:
            continue
        sid = e.get("sessionId")
        if sid in found and len(found[sid]) < limit:
            found[sid].append(e.get("display") or "")
    return found


def pick_by_screen(cands, screen):
    screen_n = norm(screen)
    if not screen_n:
        return None
    prompts = recent_prompts([c["sessionId"] for c in cands])
    best, best_score, tie = None, 0, False
    for c in cands:
        score = 0
        for p in prompts.get(c["sessionId"], []):
            n = norm(p)[:30]
            if len(n) >= 6 and n in screen_n:
                score += 1
        if score > best_score:
            best, best_score, tie = c, score, False
        elif score == best_score and score > 0:
            tie = True
    return None if tie else best


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for x in content:
            if x.get("type") == "text":
                parts.append(x.get("text", ""))
            elif x.get("type") == "image":
                parts.append("[image]")
        return "\n".join(parts)
    return ""


def result_extra(name, r):
    if not isinstance(r, dict):
        return None
    ex = {}
    if "structuredPatch" in r and isinstance(r["structuredPatch"], list):
        hunks, total = [], 0
        for h in r["structuredPatch"]:
            lines = h.get("lines") or []
            if total > 800:
                break
            total += len(lines)
            hunks.append({"oldStart": h.get("oldStart"), "newStart": h.get("newStart"), "lines": [clip(l, 500) for l in lines[:400]]})
        ex["patch"] = hunks
        if r.get("type") == "create":
            ex["created"] = True
    if "stdout" in r or "stderr" in r:
        ex["stdout"] = clip(ANSI.sub("", r.get("stdout") or ""))
        ex["stderr"] = clip(ANSI.sub("", r.get("stderr") or ""), 4000)
        if r.get("interrupted"):
            ex["interrupted"] = True
        if r.get("backgroundTaskId"):
            ex["background"] = r.get("backgroundTaskId")
        if r.get("returnCodeInterpretation"):
            ex["rc"] = r.get("returnCodeInterpretation")
    if isinstance(r.get("file"), dict) and "numLines" in r["file"]:
        ex["numLines"] = r["file"].get("numLines")
        ex["totalLines"] = r["file"].get("totalLines")
    for k in ("numFiles", "numMatches", "durationMs", "status", "totalDurationMs", "totalTokens", "agentId", "code", "bytes", "url", "isAsync"):
        if k in r and isinstance(r[k], (int, str, bool, float)):
            ex[k] = r[k]
    if isinstance(r.get("filenames"), list):
        ex["numFiles"] = len(r["filenames"])
    if isinstance(r.get("answers"), dict):
        ex["answers"] = r["answers"]
    return ex or None


def tool_input(name, inp):
    if not isinstance(inp, dict):
        return {"value": clip(inp, 4000)}
    out = {}
    for k, v in inp.items():
        if k in ("content", "new_string", "old_string", "prompt", "plan"):
            out[k] = clip(v, 20000) if isinstance(v, str) else v
        elif k == "edits" and isinstance(v, list):
            out[k] = [{"old_string": clip(e.get("old_string", ""), 8000), "new_string": clip(e.get("new_string", ""), 8000)} for e in v[:30]]
        elif isinstance(v, str):
            out[k] = clip(v, 6000)
        elif isinstance(v, (dict, list)):
            s = json.dumps(v, ensure_ascii=False)
            out[k] = v if len(s) < 8000 else clip(s, 8000)
        else:
            out[k] = v
    return out


# typed prompts; slash commands are left out (a /compact prompt is off the chain that continues at its boundary)
def is_prompt(e):
    if e.get("type") != "user" or e.get("isMeta") or e.get("isSidechain"):
        return False
    content = (e.get("message") or {}).get("content")
    if isinstance(content, str):
        return not content.startswith(("/", "<command-", "<local-command"))
    texts = [b.get("text") or "" for b in content or [] if isinstance(b, dict) and b.get("type") == "text"]
    return bool(texts) and not texts[0].startswith(("/", "<command-", "<local-command"))


# A rewind keeps the abandoned turns in the file: the active branch runs from the newest entry (or the leaf a later
# rewound last-prompt names) up the parentUuid chain; prompts forking off that chain and everything below them are dead.
def dead_uuids(path):
    parent, children, prompts, leaf = {}, {}, [], None
    try:
        with open(path, "rb") as fh:
            for line in fh:
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                if e.get("type") == "last-prompt" and e.get("rewound") and e.get("leafUuid"):
                    leaf = e["leafUuid"]
                uid = e.get("uuid")
                if not uid or e.get("isSidechain"):
                    continue
                p = e.get("parentUuid") or e.get("logicalParentUuid")
                parent[uid] = p
                children.setdefault(p, []).append(uid)
                if is_prompt(e):
                    prompts.append(uid)
                if e.get("type") != "attachment":
                    leaf = uid
    except OSError:
        return set()
    chain = set()
    while leaf and leaf not in chain:
        chain.add(leaf)
        leaf = parent.get(leaf)
    dead, todo = set(), [u for u in prompts if u not in chain and parent.get(u) in chain]
    while todo:
        u = todo.pop()
        if u not in dead:
            dead.add(u)
            todo.extend(children.get(u, []))
    return dead


# A subagent's SubagentHandback report (a meta user message or a queued command); the description of its Agent call
# when that is in the same chunk, else the page looks it up.
def handback(origin, uid, ts, descs):
    return {"k": "notice", "ts": ts, "id": uid, "level": "handback", "agentId": origin.get("from"), "text": descs.get(origin.get("from")),
            "detail": clip(origin.get("handbackReportText") or "", 40000)}


def parse(lines, meta, sidechain=False, dead=()):
    items, descs = [], {}
    for line in lines:
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("uuid") in dead:
            continue
        t = e.get("type")
        ts = e.get("timestamp")
        if e.get("gitBranch"):
            meta["gitBranch"] = None if e["gitBranch"] == "HEAD" else e["gitBranch"]
        if t == "assistant" and e.get("effort"):
            meta["effort"] = e["effort"]
        if t == "ai-title":
            meta["aiTitle"] = e.get("aiTitle")
            continue
        if t == "custom-title":
            meta["customTitle"] = e.get("customTitle")
            continue
        if t == "permission-mode":
            meta["permissionMode"] = e.get("permissionMode")
            continue
        if t == "attachment":
            a = e.get("attachment") or {}
            if a.get("type") == "model" and isinstance(a.get("identity"), dict):
                meta["model"] = a["identity"].get("marketingName") or a["identity"].get("modelId")
            elif a.get("type") == "queued_command" and isinstance(a.get("prompt"), str) and not e.get("isSidechain"):
                p = a["prompt"]
                m = TASK_RE.search(p)
                if (a.get("origin") or {}).get("handback"):
                    items.append(handback(a["origin"], e.get("uuid"), ts, descs))
                elif m and HANDBACK_POINTER not in p:
                    st = STATUS_RE.search(p)
                    items.append({"k": "notice", "ts": ts, "id": e.get("uuid"), "level": "task", "text": m.group(1).strip(), "status": st.group(1) if st else None})
                elif not p.lstrip().startswith("<"):
                    items.append({"k": "user", "ts": ts, "id": e.get("uuid"), "text": clip(PASTED_RE.sub("\n", p).strip(), 40000), "queued": True})
            continue
        if t == "cost-state":
            meta["cost"] = e.get("totalCostUSD")
            continue
        if t == "system":
            st = e.get("subtype")
            if st == "compact_boundary":
                items.append({"k": "notice", "ts": ts, "id": e.get("uuid"), "level": "compact", "text": "Conversation compacted"})
            elif st == "turn_duration":
                items.append({"k": "turn", "ts": ts, "id": e.get("uuid"), "ms": e.get("durationMs")})
            elif st == "local_command":
                c = e.get("content") or ""
                m = CMD_RE.search(c) if c.startswith("<command-") else None
                if m:
                    ma = ARGS_RE.search(c)
                    items.append({"k": "user", "ts": ts, "id": e.get("uuid"), "text": (m.group(1).strip() + " " + (ma.group(1).strip() if ma else "")).strip(), "command": True})
                    continue
                m = STDOUT_RE.search(c)
                out = ANSI.sub("", m.group(2)).strip() if m else ""
                if out:
                    items.append({"k": "notice", "ts": ts, "id": e.get("uuid"), "level": "command", "text": clip(out, 8000)})
            elif st in ("informational", "api_error") and e.get("content"):
                items.append({"k": "notice", "ts": ts, "id": e.get("uuid"), "level": e.get("level") or "info", "text": clip(ANSI.sub("", str(e.get("content"))), 4000)})
            continue
        if t not in ("user", "assistant") or (e.get("isSidechain") and not sidechain):
            continue
        msg = e.get("message") or {}
        content = msg.get("content")
        uid = e.get("uuid")
        if t == "user":
            if e.get("isCompactSummary"):
                items.append({"k": "notice", "ts": ts, "id": uid, "level": "compact", "text": "Conversation compacted", "detail": clip(text_of(content), 20000)})
                continue
            if isinstance(content, str):
                content = [{"type": "text", "text": content}]
            if not isinstance(content, list):
                continue
            texts, images = [], 0
            for b in content:
                bt = b.get("type")
                if bt == "tool_result":
                    c = b.get("content")
                    txt = text_of(c)
                    item = {"k": "result", "ts": ts, "tid": b.get("tool_use_id"), "err": bool(b.get("is_error")), "text": clip(ANSI.sub("", txt))}
                    ex = result_extra(None, e.get("toolUseResult"))
                    if ex:
                        item["extra"] = ex
                        if ex.get("agentId"):
                            descs[ex["agentId"]] = descs.get(b.get("tool_use_id"))
                    items.append(item)
                elif bt == "text":
                    texts.append(b.get("text", ""))
                elif bt == "image":
                    images += 1
            if (e.get("origin") or {}).get("handback"):
                items.append(handback(e["origin"], uid, ts, descs))
                continue
            if e.get("isMeta") or not (texts or images):
                continue
            txt = PASTED_RE.sub("\n", "\n".join(texts)).strip()
            s = txt
            if s.startswith("[Request interrupted"):
                items.append({"k": "notice", "ts": ts, "id": uid, "level": "interrupt", "text": "Interrupted"})
                continue
            m = CMD_RE.search(txt) if s.startswith("<command-") else None
            if m:
                name = m.group(1).strip()
                ma = ARGS_RE.search(txt)
                args = ma.group(1).strip() if ma else ""
                items.append({"k": "user", "ts": ts, "id": uid, "text": (name + " " + args).strip(), "command": True})
                continue
            m = STDOUT_RE.search(txt) if s.startswith("<local-command") else None
            if m:
                out = ANSI.sub("", m.group(2)).strip()
                if out:
                    items.append({"k": "notice", "ts": ts, "id": uid, "level": "command", "text": clip(out, 8000)})
                continue
            m = TASK_RE.search(txt) if s.startswith("<task-notification") else None
            if m and HANDBACK_POINTER in txt:
                continue
            if m:
                st = STATUS_RE.search(txt)
                items.append({"k": "notice", "ts": ts, "id": uid, "level": "task", "text": m.group(1).strip(), "status": st.group(1) if st else None})
                continue
            if s.startswith(("<local-command-caveat", "Caveat:", "<system-reminder")):
                continue
            items.append({"k": "user", "ts": ts, "id": uid, "text": clip(txt, 40000), "images": images})
        else:
            if not isinstance(content, list):
                continue
            mid = msg.get("id") or uid
            if msg.get("model") and msg.get("model") != "<synthetic>":
                meta["modelId"] = msg.get("model")
            first = len(items)
            for i, b in enumerate(content):
                bt = b.get("type")
                bid = (mid or "") + ":" + str(i)
                if bt == "text" and b.get("text", "").strip():
                    if msg.get("model") == "<synthetic>" and b["text"].startswith("No response requested"):
                        continue
                    items.append({"k": "text", "ts": ts, "id": bid, "text": b["text"], "err": bool(e.get("isApiErrorMessage"))})
                elif bt == "thinking" and (b.get("thinking", "").strip() or e.get("thinkingDurationMs")):
                    items.append({"k": "thinking", "ts": ts, "id": bid, "text": clip(b.get("thinking", ""), 20000), "ms": e.get("thinkingDurationMs")})
                elif bt == "tool_use" and b.get("name") == "SubagentHandback" and isinstance((b.get("input") or {}).get("message"), str):
                    items.append({"k": "text", "ts": ts, "id": bid, "text": b["input"]["message"], "err": False})
                elif bt in ("tool_use", "server_tool_use"):
                    if b.get("name") in ("Agent", "Task"):
                        descs[b.get("id")] = (b.get("input") or {}).get("description")
                    items.append({"k": "tool", "ts": ts, "id": b.get("id"), "name": b.get("name"), "input": tool_input(b.get("name"), b.get("input"))})
            usage = msg.get("usage")
            if isinstance(usage, dict):
                meta["contextTokens"] = (usage.get("input_tokens") or 0) + (usage.get("cache_read_input_tokens") or 0) + (usage.get("cache_creation_input_tokens") or 0)
                # every line of one API message repeats its usage, so the page counts output tokens once per mid
                for it in items[first:]:
                    it["mid"] = mid
                    it["out"] = usage.get("output_tokens") or 0
    return items


def read_range(path, start, end, align_start):
    with open(path, "rb") as fh:
        fh.seek(start)
        data = fh.read(end - start)
    if align_start and start > 0:
        nl = data.find(b"\n")
        if nl < 0:
            return [], end, end
        start += nl + 1
        data = data[nl + 1:]
    cut = data.rfind(b"\n") + 1
    return data[:cut].splitlines(), start, start + cut


def pick_session(req, res):
    sid = req.get("sid")
    if sid:
        sid = str(sid)
        chosen = next((c for c in live_sessions(None) if c.get("muxySessionId") == sid), None)
        res["how"] = "bound"
        if chosen is not None:
            return chosen, os.path.join(project_dir(chosen["cwd"]), chosen["sessionId"] + ".jsonl")
        res["muxy"] = muxy_status(sid)
        prev = req.get("file")
        return None, prev if prev and os.path.exists(prev) else None
    cwd = req.get("cwd") or ""
    # pinned follow (V2 mirror): one TUI by pid (survives /clear) or Claude session id, else the given file
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
    raise SystemExit("poll needs sid or a pinned transcript (pid / sessionId / file)")


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


def daemon_state_path(sid):
    return os.path.join(STATE, "sessions", sid, "state.json") if re.fullmatch(r"[A-Za-z0-9_-]{1,80}", sid or "") else None


def read_json(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return None


# Chat mode: the daemon's rows decide while its CLI runs; a stopped daemon leaves the transcript to the TUI (if any).
def chat_state(path):
    st = read_json(path) if path else None
    if st and st.get("status") != "stopped" and isinstance(st.get("pid"), int) and alive(st["pid"]) and isinstance(st.get("agents"), list):
        return st
    return None


def daemon_agent_status(path, agent_id):
    st = chat_state(path)
    rows = tracker.settle([r for r in st["agents"] if r.get("agentId") == agent_id], True, (st.get("startedAt") or 0) / 1000.0) if st else []
    return rows[-1]["status"] if rows else None


def agent_status(f, daemon=None):
    inline = "#" in f
    st = None if inline else daemon_agent_status(daemon_state_path(daemon), os.path.basename(f)[6:-6])
    if st:
        return st
    main = f.split("#")[0] if inline else os.path.dirname(os.path.dirname(f)) + ".jsonl"
    a = next((a for a in session_rows(main, daemon) if a.get("inline" if inline else "file") == f), None)
    return a["status"] if a else "stopped"


def mtime(path):
    try:
        return str(os.stat(path).st_mtime_ns)
    except OSError:
        return None


def file_size(path):
    try:
        return os.path.getsize(path)
    except OSError:
        return -1


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


# Long poll: returns once the transcript or the Claude session file differs from what the last poll saw.
def op_wait(req):
    w = req.get("watch") or {}
    deadline = time.time() + min(int(req.get("timeoutMs") or 25000), 28000) / 1000.0
    task = w.get("task")
    while time.time() < deadline:
        if w.get("file") and file_size(w["file"]) != w.get("size"):
            return {"changed": "file"}
        if task and mtime(task[0]) != task[3]:
            task[3] = mtime(task[0])
            if daemon_agent_status(task[0], task[1]) != task[2]:
                return {"changed": "task"}
        if w.get("pid"):
            if not alive(w["pid"]) or pid_state(w["pid"]) != w.get("state"):
                return {"changed": "session"}
        elif mtime(SESSIONS) != w.get("dir"):
            return {"changed": "sessions"}
        time.sleep(0.15)
    return {"changed": None}


# Written by the optional claude-pane-title hook: a topic that follows the conversation (ai-title is set once).
def session_topic(sid):
    try:
        with open(os.path.join(HOME, ".cache", "claude-pane-title", sid + ".json")) as fh:
            return json.load(fh).get("topic")
    except Exception:
        return None


def head_meta(path):
    meta = {}
    try:
        with open(path, "rb") as fh:
            for i, line in enumerate(fh):
                if i > 400:
                    break
                if b'"ai-title"' in line or b'"custom-title"' in line or b'"permission-mode"' in line or b'"type":"model"' in line or b'"identity"' in line:
                    parse([line], meta)
    except Exception:
        pass
    return meta


def op_older(req):
    path = req["file"]
    before = min(int(req["before"]), os.path.getsize(path))
    start = max(0, before - int(req.get("tail") or TAIL))
    lines, start, end = read_range(path, start, before, True)
    meta = {}
    sidechain = bool(req.get("sidechain"))
    items = parse(lines, meta, sidechain, () if sidechain else dead_uuids(path))
    if start == 0:
        meta.update(head_meta(path))
    return {"items": items, "start": start, "meta": meta}


def tail_lines(path, size):
    try:
        total = os.path.getsize(path)
        lines, _, _ = read_range(path, max(0, total - size), total, True)
        return lines
    except OSError:
        return []


def activity(b):
    if b.get("type") == "text":
        return b.get("text", "").strip().split("\n")[0][:160]
    inp = b.get("input") if isinstance(b.get("input"), dict) else {}
    for k in ("description", "file_path", "pattern", "command", "url", "query", "skill", "message"):
        v = inp.get(k)
        if isinstance(v, str) and v.strip():
            v = v.strip().split("\n")[0]
            if k == "file_path":
                v = os.path.basename(v)
            return (b.get("name") or "tool") + " · " + v[:140]
    return b.get("name") or "tool"


def agent_activity(path):
    out = {"last": None, "lastTs": None}
    for line in reversed(tail_lines(path, 200000)):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        ts = e.get("timestamp")
        if ts and (out["lastTs"] is None or ts > out["lastTs"]):
            out["lastTs"] = ts
        content = (e.get("message") or {}).get("content")
        if e.get("type") != "assistant" or not isinstance(content, list):
            continue
        blocks = [b for b in content if b.get("type") == "tool_use" or (b.get("type") == "text" and b.get("text", "").strip())]
        if blocks:
            out["last"] = activity(blocks[-1])
            break
    return out


AGENT_MARKERS = (b'"name":"Agent"', b'"name":"Task"', b'"name":"SendMessage"', b'"agentId"', b'"resumedAgentId"', b"<task-notification>",
                 b'"run_in_background":true', b'"backgroundTaskId"')


def first_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if b.get("type") == "text")
    return ""


# Old Claude Code logged subagent messages inline (isSidechain, chained by parentUuid) instead of in subagents/.
def inline_threads(lines):
    roots, threads = {}, {}
    for line in lines:
        if b'"isSidechain":true' not in line:
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if not e.get("isSidechain") or not e.get("uuid"):
            continue
        root = roots.get(e.get("parentUuid")) or e["uuid"]
        roots[e["uuid"]] = root
        t = threads.setdefault(root, {"prompt": None, "lines": [], "last": None, "lastTs": None})
        t["lines"].append(line)
        msg = e.get("message") or {}
        if t["prompt"] is None and e.get("type") == "user":
            t["prompt"] = first_text(msg.get("content")).strip()
        if e.get("timestamp"):
            t["lastTs"] = e["timestamp"]
        content = msg.get("content")
        if e.get("type") == "assistant" and isinstance(content, list):
            blocks = [b for b in content if b.get("type") == "tool_use" or (b.get("type") == "text" and b.get("text", "").strip())]
            if blocks:
                t["last"] = activity(blocks[-1])
    return threads


def output_tail(path, n=15):
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            fh.seek(max(0, size - 4000))
            text = ANSI.sub("", fh.read().decode("utf-8", "replace"))
    except OSError:
        return None
    lines = [l.rstrip() for l in text.replace("\r", "\n").split("\n") if l.strip()]
    return "\n".join(lines[-n:])


# The shared reducer over one transcript; Agent prompts are kept for matching inline threads.
def track(path, nested, parent=None):
    t, prompts, keys = tracker.Tracker(parent=parent), {}, ()
    try:
        with open(path, "rb") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return t, prompts, []
    for line in lines:
        if not any(m in line for m in AGENT_MARKERS) and not (b'"tool_result"' in line and any(k in line for k in keys)):
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("isSidechain") and not nested:
            continue
        if t.feed(e):
            keys = [('"%s"' % i).encode() for i in t.rows]
        content = (e.get("message") or {}).get("content")
        for b in content if isinstance(content, list) else []:
            if b.get("type") == "tool_use" and b.get("name") in ("Agent", "Task"):
                prompts[b.get("id")] = ((b.get("input") or {}).get("prompt") or "").strip()
    return t, prompts, lines


def agent_ids(sub):
    ids = {}
    for f in glob.glob(os.path.join(sub, "agent-*.meta.json")):
        try:
            with open(f) as fh:
                ids[json.load(fh).get("toolUseId")] = os.path.basename(f)[6:-10]
        except (OSError, ValueError):
            continue
    return ids


# What only the files know: the subagent transcript and its last activity, a background command's output tail.
def enrich(a, sub, ids):
    if a["kind"] == "agent" and not a.get("agentId"):
        a["agentId"] = ids.get(a["id"])
    f = os.path.join(sub, "agent-%s.jsonl" % a["agentId"]) if a.get("agentId") else None
    if f and os.path.exists(f):
        a.update(agent_activity(f))
        a["file"] = f
    if a["kind"] == "bash" and a.get("output"):
        a["tail"] = output_tail(a["output"])
        a["last"] = (a["tail"] or "").split("\n")[-1][:160] or None
    return a


# Each agent is followed by what it spawned (rows of its own transcript); daemon rows replace the scanned ones.
def collect(path, sub, ids, nested, parent, depth, drows, out):
    t, prompts, lines = track(path, nested, parent)
    threads = None
    for a in t.list():
        a = enrich(dict(drows.pop(a["id"], None) or a), sub, ids)
        if a.get("file") is None and a["kind"] == "agent" and not nested and prompts.get(a["id"]):
            if threads is None:
                threads = inline_threads(lines)
            root = next((r for r, th in threads.items() if th["prompt"] == prompts[a["id"]]), None)
            if root is not None:
                a["inline"] = path + "#" + root
                a["last"], a["lastTs"] = threads[root]["last"], threads[root]["lastTs"]
        out.append(a)
        if a.get("file") and depth < 4:
            collect(a["file"], sub, ids, True, a["id"], depth + 1, drows, out)


def session_rows(path, daemon=None):
    nested = os.path.basename(os.path.dirname(path)) == "subagents"
    main = os.path.dirname(os.path.dirname(path)) + ".jsonl" if nested else path
    sub = main[:-6] + "/subagents"
    ids = agent_ids(sub)
    st = chat_state(daemon_state_path(daemon))
    drows = {r["id"]: r for r in st["agents"]} if st else {}
    out = []
    collect(path, sub, ids, nested, None, 0, drows, out)
    if st:
        if not nested:
            out += [enrich(dict(a), sub, ids) for a in drows.values()]
        return tracker.settle(out, True, (st.get("startedAt") or 0) / 1000.0)
    sid = os.path.basename(main)[:-6]
    live = next((s for s in live_sessions(None) if s["sessionId"] == sid), None)
    since = live["startedAt"] / 1000.0 if live and isinstance(live.get("startedAt"), (int, float)) else None
    return tracker.settle(out, live is not None, since)


def op_agents(req):
    path = req.get("file")
    return {"agents": session_rows(path, req.get("daemon")) if path and os.path.exists(path) else []}


def frontmatter(path):
    desc, hint = "", ""
    try:
        with open(path, errors="replace") as fh:
            head = fh.read(4000)
    except Exception:
        return desc, hint
    if head.startswith("---"):
        end = head.find("\n---", 3)
        block = head[3:end] if end > 0 else ""
        for line in block.splitlines():
            m = re.match(r"\s*(description|argument-hint)\s*:\s*(.*)", line)
            if m:
                v = m.group(2).strip().strip("\"'")
                if m.group(1) == "description":
                    desc = v
                else:
                    hint = v
        body = head[end + 4:] if end > 0 else head
    else:
        body = head
    if not desc:
        for line in body.splitlines():
            line = line.strip().lstrip("#").strip()
            if line:
                desc = line
                break
    return desc[:200], hint[:80]


def scan_commands(root, prefix, source, out):
    cdir = os.path.join(root, "commands")
    for f in glob.glob(os.path.join(cdir, "**", "*.md"), recursive=True):
        rel = os.path.relpath(f, cdir)[:-3].replace(os.sep, ":")
        desc, hint = frontmatter(f)
        out.append({"name": prefix + rel, "desc": desc, "hint": hint, "source": source})
    for f in glob.glob(os.path.join(root, "skills", "*", "SKILL.md")):
        name = os.path.basename(os.path.dirname(f))
        desc, hint = frontmatter(f)
        out.append({"name": prefix + name, "desc": desc, "hint": hint, "source": source + " skill"})


def op_meta(req):
    cwd = req.get("cwd") or ""
    cmds = []
    scan_commands(CLAUDE, "", "user", cmds)
    if cwd:
        scan_commands(os.path.join(cwd, ".claude"), "", "project", cmds)
    try:
        with open(os.path.join(CLAUDE, "plugins", "installed_plugins.json")) as fh:
            plugins = json.load(fh).get("plugins", {})
        for key, installs in plugins.items():
            pname = key.split("@")[0]
            for inst in installs:
                if inst.get("scope") == "project" and inst.get("projectPath") != cwd:
                    continue
                p = inst.get("installPath")
                if p and os.path.isdir(p):
                    scan_commands(p, pname + ":", "plugin", cmds)
                    break
    except Exception:
        pass
    seen, uniq = set(), []
    for c in cmds:
        if c["name"] not in seen:
            seen.add(c["name"])
            uniq.append(c)
    return {"commands": uniq, "history": op_history(cwd)}


def op_history(cwd, limit=300):
    path = os.path.join(CLAUDE, "history.jsonl")
    out, seen = [], set()
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            fh.seek(max(0, size - 3000000))
            lines = fh.read().splitlines()
    except Exception:
        return out
    for line in reversed(lines):
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("project") != cwd:
            continue
        text = e.get("display") or ""
        pasted = e.get("pastedContents") or {}
        for k, v in pasted.items():
            if isinstance(v, dict) and v.get("type") == "text" and v.get("content"):
                text = re.sub(r"\[Pasted text #" + re.escape(str(k)) + r"[^\]]*\]", lambda m: v["content"], text)
        if text and text not in seen:
            seen.add(text)
            out.append(text)
            if len(out) >= limit:
                break
    return out


def op_files(req):
    cwd = live_cwd(req.get("cwd") or ".")
    q = (req.get("q") or "").lower()
    files = []
    try:
        r = subprocess.run(["git", "ls-files", "-co", "--exclude-standard"], cwd=cwd, capture_output=True, text=True, timeout=8)
        if r.returncode == 0:
            files = r.stdout.splitlines()
    except Exception:
        pass
    if not files:
        for root, dirs, names in os.walk(cwd):
            dirs[:] = [x for x in dirs if not x.startswith(".") and x not in ("node_modules", "build", "dist", "target")]
            for n in names:
                files.append(os.path.relpath(os.path.join(root, n), cwd))
            if len(files) > 50000:
                break
    dirs = set()
    for f in files:
        p = os.path.dirname(f)
        while p and p not in dirs:
            dirs.add(p)
            p = os.path.dirname(p)
    pool = files + [x + "/" for x in dirs]
    scored = []
    for f in pool:
        fl = f.lower()
        if not q:
            score = len(f)
        else:
            base = os.path.basename(fl.rstrip("/"))
            if base.startswith(q):
                score = len(f)
            elif q in base:
                score = 1000 + len(f)
            elif q in fl:
                score = 2000 + len(f)
            else:
                it = iter(fl)
                if all(ch in it for ch in q):
                    score = 5000 + len(f)
                else:
                    continue
        scored.append((score, f))
    scored.sort()
    return {"files": [f for _, f in scored[:40]]}


EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
DIFF_CAP = 2000000
UNTRACKED_MAX = 200
UNTRACKED_BYTES = 512000


# A removed worktree `{repo}-{id}` (ticket-board human-testing moves its changes to the main checkout): use `{repo}`.
def live_cwd(cwd):
    p = (cwd or ".").rstrip("/") or "/"
    while not os.path.isdir(p) and re.search(r"-[^/-]+$", p):
        p = re.sub(r"-[^/-]+$", "", p)
    return p if os.path.isdir(p) else cwd


def git(cwd, args, timeout=20):
    return subprocess.run(["git", "-c", "core.quotePath=false"] + args, cwd=live_cwd(cwd), capture_output=True, text=True, errors="replace", timeout=timeout)


def diff_path(s):
    s = s.split("\t")[0]
    if s == "/dev/null":
        return None
    return s[2:] if s[:2] in ("a/", "b/") else s


def parse_diff(text, files, budget):
    f = None
    h = None
    for line in text.split("\n"):
        if line.startswith("diff --git "):
            m = re.match(r"diff --git a/(.*) b/(.*)$", line)
            f = {"path": m.group(2) if m else line[11:], "old": None, "status": "modified", "binary": False, "add": 0, "del": 0, "hunks": [], "truncated": False}
            files.append(f)
            h = None
        elif f is None:
            continue
        elif h is None and line.startswith("--- "):
            f["old"] = diff_path(line[4:])
        elif h is None and line.startswith("+++ "):
            p = diff_path(line[4:])
            if p is not None:
                f["path"] = p
            else:
                f["status"] = "deleted"
        elif h is None and line.startswith("new file mode"):
            f["status"] = "added"
        elif h is None and line.startswith("deleted file mode"):
            f["status"] = "deleted"
        elif h is None and line.startswith("rename from "):
            f["old"] = line[12:]
            f["status"] = "renamed"
        elif h is None and line.startswith("rename to "):
            f["path"] = line[10:]
        elif h is None and line.startswith("Binary files "):
            f["binary"] = True
        elif line.startswith("@@"):
            m = re.match(r"@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)", line)
            h = None
            if m and budget[0] > 0:
                h = {"o": int(m.group(1)), "n": int(m.group(2)), "head": m.group(3), "lines": []}
                f["hunks"].append(h)
            elif m:
                f["truncated"] = True
        elif h is not None and line[:1] in ("+", "-", " "):
            h["lines"].append(line)
            budget[0] -= len(line) + 16
            if line[0] == "+":
                f["add"] += 1
            elif line[0] == "-":
                f["del"] += 1
    return files


FILE_TEXT_CAP = 3000000
REV_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9._/~^@{}:+-]*(\.\.\.?[A-Za-z0-9_][A-Za-z0-9._/~^@{}:+-]*)?")


def prompt_text(e):
    if e.get("type") != "user" or e.get("isMeta") or e.get("isSidechain") or e.get("isCompactSummary"):
        return None
    txt = text_of((e.get("message") or {}).get("content")).strip()
    if not txt or txt.startswith(("<", "[Request interrupted", "Caveat:")):
        return None
    return re.sub(r"\s+", " ", PASTED_RE.sub(" ", txt))[:160]


# Claude's own edits between one prompt and the next, as diff files (the hunks of each Edit / Write in order).
def turn_files(path, uuid, budget):
    files, by_path, inside = [], {}, False
    with open(path, "rb") as fh:
        for line in fh:
            if not inside and uuid.encode() not in line:
                continue
            if inside and b'"structuredPatch"' not in line and b'"type":"user"' not in line:
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if not inside:
                inside = e.get("uuid") == uuid
                continue
            if prompt_text(e) is not None:
                break
            r = e.get("toolUseResult")
            if not isinstance(r, dict) or not r.get("filePath") or "structuredPatch" not in r or e.get("isSidechain"):
                continue
            p = r["filePath"]
            f = by_path.get(p)
            if f is None:
                f = {"path": p, "old": None, "status": "added" if r.get("type") == "create" else "modified", "binary": False, "add": 0, "del": 0, "hunks": [], "truncated": False}
                by_path[p] = f
                files.append(f)
            patch = r.get("structuredPatch") or []
            if r.get("type") == "create" and not patch and isinstance(r.get("content"), str):
                lines = r["content"].split("\n")
                patch = [{"oldStart": 0, "newStart": 1, "lines": ["+" + l for l in lines]}]
            for h in patch:
                if budget[0] <= 0:
                    f["truncated"] = True
                    break
                lines = [l for l in (h.get("lines") or []) if l[:1] in ("+", "-", " ")]
                f["hunks"].append({"o": h.get("oldStart") or 0, "n": h.get("newStart") or 0, "head": "", "lines": lines})
                for l in lines:
                    budget[0] -= len(l) + 16
                    f["add"] += l[0] == "+"
                    f["del"] += l[0] == "-"
    return files


# Review "expand context": the whole file on the diff's new side (working tree, or `rev:path`).
def op_file_text(req):
    cwd = req.get("cwd") or "."
    t = git(cwd, ["rev-parse", "--show-toplevel"])
    root = t.stdout.strip() if t.returncode == 0 else cwd
    path, rev = req["path"], req.get("rev")
    if rev:
        if not REV_RE.fullmatch(rev) or path.startswith("-"):
            raise SystemExit("not a revision: " + rev)
        t = git(root, ["show", rev + ":" + path])
        if t.returncode != 0:
            raise SystemExit((t.stderr or "git show failed").strip())
        text = t.stdout
    else:
        with open(path if os.path.isabs(path) else os.path.join(root, path), errors="replace") as fh:
            text = fh.read(FILE_TEXT_CAP)
    lines = text[:FILE_TEXT_CAP].split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return {"lines": lines}


def op_branch(req):
    try:
        r = git(req.get("cwd") or ".", ["symbolic-ref", "--short", "-q", "HEAD"], timeout=5)
        return {"gitBranch": r.stdout.strip() or None}
    except Exception:
        return {"gitBranch": None}


def op_review_sources(req):
    out = {"turns": [], "commits": []}
    path = req.get("file")
    if path and os.path.exists(path):
        turns = []
        with open(path, "rb") as fh:
            for line in fh:
                if b'"type":"user"' not in line:
                    continue
                if b'"structuredPatch"' in line and turns:
                    turns[-1]["edits"] += 1
                    continue
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                t = prompt_text(e)
                if t is not None:
                    turns.append({"uuid": e.get("uuid"), "ts": e.get("timestamp"), "text": t, "edits": 0})
        out["turns"] = [t for t in turns if t["edits"] > 0][-20:][::-1]
    try:
        out["root"] = git(req.get("cwd") or ".", ["rev-parse", "--show-toplevel"]).stdout.strip() or None
        r = git(req.get("cwd") or ".", ["log", "-n", "30", "--format=%H%x09%h%x09%ct%x09%s"])
        for l in r.stdout.splitlines() if r.returncode == 0 else []:
            p = l.split("\t", 3)
            if len(p) == 4:
                out["commits"].append({"sha": p[0], "short": p[1], "ts": int(p[2]) * 1000, "subject": p[3][:160]})
        out["base"] = base_branch(req.get("cwd") or ".")
    except Exception:
        pass
    return out


# The branch this one was forked from: the first of master/main (local, then origin) that is not the current branch.
def base_branch(cwd):
    head = git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"], timeout=5).stdout.strip()
    for ref in ("master", "main", "origin/master", "origin/main"):
        if ref == head or git(cwd, ["rev-parse", "--verify", "-q", ref + "^{commit}"], timeout=5).returncode != 0:
            continue
        return ref
    return None


def op_diff(req):
    cwd = req.get("cwd") or "."
    if req.get("turn"):
        budget = [DIFF_CAP]
        files = turn_files(req["file"], req["turn"], budget)
        root = git(cwd, ["rev-parse", "--show-toplevel"]).stdout.strip() or cwd
        for f in files:
            for r in (root, cwd.rstrip("/")):
                if f["path"].startswith(r + "/"):
                    f["path"] = f["path"][len(r) + 1:]
                    break
        return {"root": root, "files": files, "truncated": budget[0] <= 0}
    try:
        r = git(cwd, ["rev-parse", "--show-toplevel"])
    except Exception as e:
        return {"error": "git failed: %s" % e}
    if r.returncode != 0:
        return {"error": "Not a git repository: " + cwd}
    root = r.stdout.strip()
    files = []
    budget = [DIFF_CAP]
    rev = req.get("commit") or req.get("range")
    if rev:
        if not REV_RE.fullmatch(rev):
            return {"error": "Not a commit or range: " + rev}
        args = [rev] if req.get("range") else [rev + "^!"]
        r = git(root, ["diff", "--no-color", "--no-ext-diff", "-M"] + args)
        if r.returncode != 0 and req.get("commit"):
            r = git(root, ["diff", "--no-color", "--no-ext-diff", "-M", EMPTY_TREE, rev])
        if r.returncode != 0:
            return {"error": (r.stderr or "git diff failed").strip()}
        parse_diff(r.stdout, files, budget)
        return {"root": root, "files": files, "truncated": budget[0] <= 0}
    base = "HEAD" if git(root, ["rev-parse", "--verify", "-q", "HEAD"]).returncode == 0 else EMPTY_TREE
    if req.get("base"):
        if not REV_RE.fullmatch(req["base"]):
            return {"error": "Not a branch: " + req["base"]}
        r = git(root, ["merge-base", req["base"], "HEAD"])
        if r.returncode != 0:
            return {"error": (r.stderr or "No common ancestor with " + req["base"]).strip()}
        base = r.stdout.strip()
    r = git(root, ["diff", "--no-color", "--no-ext-diff", "-M", base])
    if r.returncode != 0:
        return {"error": (r.stderr or "git diff failed").strip()}
    parse_diff(r.stdout, files, budget)
    r = git(root, ["ls-files", "-o", "--exclude-standard", "-z"])
    untracked = [p for p in r.stdout.split("\0") if p] if r.returncode == 0 else []
    for p in untracked[:UNTRACKED_MAX]:
        full = os.path.join(root, p)
        if not os.path.isfile(full) or os.path.getsize(full) > UNTRACKED_BYTES or budget[0] <= 0:
            files.append({"path": p, "old": None, "status": "untracked", "binary": False, "add": 0, "del": 0, "hunks": [], "truncated": True})
            continue
        n = len(files)
        parse_diff(git(root, ["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", p]).stdout, files, budget)
        if len(files) == n:
            files.append({"path": p, "old": None, "status": "untracked", "binary": False, "add": 0, "del": 0, "hunks": [], "truncated": False})
        files[-1]["status"] = "untracked"
    return {"root": root, "files": files, "truncated": budget[0] <= 0 or len(untracked) > UNTRACKED_MAX}


def op_write_image(req):
    d = "/tmp/claude-chat-images"
    os.makedirs(d, exist_ok=True)
    name = os.path.basename(req["name"])
    path = os.path.join(d, name)
    with open(path, "ab" if req.get("append") else "wb") as fh:
        fh.write(base64.b64decode(req["b64"]))
    return {"path": path, "size": os.path.getsize(path)}


def op_write_export(req):
    path = os.path.join(os.path.expanduser(req["cwd"]), os.path.basename(req["name"]))
    with open(path, "a" if req.get("append") else "w", encoding="utf-8") as fh:
        fh.write(req["text"])
    return {"path": path}


def op_image(req):
    needle = ('"%s"' % req["id"]).encode()
    with open(req["file"].split("#")[0], "rb") as fh:
        for line in fh:
            if needle not in line:
                continue
            e = json.loads(line)
            content = (e.get("message") or {}).get("content")
            if e.get("uuid") != req["id"] or not isinstance(content, list):
                continue
            src = [b for b in content if b.get("type") == "image"][int(req.get("n") or 0)].get("source") or {}
            data = src.get("data") or ""
            off = int(req.get("offset") or 0)
            return {"media": src.get("media_type") or "image/png", "data": data[off:off + IMAGE_CHUNK], "total": len(data)}
    raise ValueError("image not found")


GX_STATUSLINE = os.path.join(HOME, ".local", "state", "ghostex", "agent-hooks", "claude-statusline")
DEFAULT_USAGE_DIR = os.path.join(HOME, ".claude-usage")


def load_config():
    try:
        with open(CONFIG) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def op_stats(req):
    out = {"status": None, "usage": None, "history": []}
    sid = str(req.get("sessionId") or "")
    if re.fullmatch(r"[0-9a-f-]{36}", sid):
        for d in (os.path.join(STATE, "statusline"), GX_STATUSLINE):
            try:
                with open(os.path.join(d, sid + ".json")) as fh:
                    out["status"] = json.load(fh)
                break
            except (OSError, ValueError):
                pass
    usage_dir = os.path.expanduser(load_config().get("usageDir") or DEFAULT_USAGE_DIR)
    try:
        with open(os.path.join(usage_dir, "usage.json")) as fh:
            out["usage"] = json.load(fh)
    except (OSError, ValueError):
        pass
    hist = os.path.join(STATE, "usage-history.jsonl")
    if not os.path.exists(hist):
        hist = os.path.join(usage_dir, "history.jsonl")
    cutoff = time.time() - 86400
    try:
        with open(hist, "rb") as fh:
            fh.seek(max(0, os.path.getsize(hist) - 60000))
            for line in fh.read().splitlines():
                try:
                    h = json.loads(line)
                except ValueError:
                    continue
                if h.get("ts", 0) >= cutoff:
                    out["history"].append(h)
    except OSError:
        pass
    return out


POS_RE = re.compile(r"^(.+?)(?::(\d+)(?::\d+)?)?$")


CWD_RE = re.compile(r'"cwd":"(/[^"]+)"|\bcd (~?/[\w.@~+/-]+)')
PATH_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.@~+-/")


def resolve_from_transcript(transcript, rel):
    # Claude writes paths relative to the project it works in, not the chat cwd.
    rel = os.path.normpath(rel).lstrip("./")
    try:
        with open(transcript, "rb") as fh:
            fh.seek(max(0, os.path.getsize(transcript) - 30000000))
            data = fh.read().decode("utf-8", "replace")
    except (OSError, TypeError):
        return None
    hits = []
    needle = "/" + rel
    i = data.find(needle)
    while i >= 0:
        j = i
        while j > 0 and data[j - 1] in PATH_CHARS:
            j -= 1
        if data[j:i].startswith("/"):
            hits.append((i, data[j:i]))
        i = data.find(needle, i + 1)
    hits += [(m.start(), os.path.expanduser(m.group(1) or m.group(2))) for m in CWD_RE.finditer(data)]
    seen = set()
    for _, base in sorted(hits, reverse=True):
        if base in seen:
            continue
        seen.add(base)
        cand = os.path.join(base, rel)
        if os.path.isfile(cand):
            return cand
        # Claude often names a class without its extension (`common/Foo` for common/Foo.java).
        files = [f for f in glob.glob(glob.escape(cand) + ".*") if os.path.isfile(f)]
        if len(files) == 1:
            return files[0]
    return None


def open_local(path, line, app):
    if app == "finder":
        cands = [["open", "-R", path]]
    elif app == "idea":
        cands = [["open", "-a", n, path] for n in ("IntelliJ IDEA", "IntelliJ IDEA Ultimate", "IntelliJ IDEA CE")]
        if shutil.which("idea"):
            cands.insert(0, ["idea"] + (["--line", line] if line else []) + [path])
    elif app == "zed":
        cands = [["open", "-a", "Zed", path]]
        if shutil.which("zed"):
            cands.insert(0, ["zed", path + (":" + line if line else "")])
    else:
        raise SystemExit("unknown app: " + app)
    err = ""
    for argv in cands:
        p = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
        try:
            err = p.communicate(timeout=10)[1].decode("utf-8", "replace").strip()
        except subprocess.TimeoutExpired:
            return
        if p.returncode == 0:
            return
    raise SystemExit(err or "open failed")


def bridge_request(bridge, kind, path, line, app):
    root = os.path.normpath(bridge["root"])
    rid = "%s-%d-%d" % (kind, int(time.time() * 1000), os.getpid())
    req_dir = os.path.join(bridge["dir"], "req")
    os.makedirs(req_dir, exist_ok=True)
    tmp = os.path.join(bridge["dir"], "." + rid + ".tmp")
    with open(tmp, "w") as fh:
        json.dump({"id": rid, "path": path or root, "line": int(line) if line else None, "app": app, "root": root, "ts": time.time()}, fh)
    req_path = os.path.join(req_dir, rid + ".json")
    os.rename(tmp, req_path)
    res = os.path.join(bridge["dir"], "res", rid + ".json")
    for _ in range(50):
        try:
            with open(res) as fh:
                r = json.load(fh)
        except (OSError, ValueError):
            time.sleep(0.1)
            continue
        os.unlink(res)
        if not r.get("ok"):
            raise SystemExit(r.get("error") or kind + " failed")
        return r
    try:
        os.unlink(req_path)
    except OSError:
        pass
    raise SystemExit("open-file bridge not responding — is the host LaunchAgent installed?")


def open_via_bridge(path, line, app, bridge):
    root = os.path.normpath(bridge["root"])
    if path != root and not path.startswith(root.rstrip("/") + "/"):
        raise SystemExit("only files under " + root + " can be opened on the Mac")
    bridge_request(bridge, "open", path, line, app)


def resolve_from_ancestors(cwd, rel):
    d = os.path.dirname(os.path.normpath(cwd)) if cwd else None
    while d and d != os.path.dirname(d):
        if os.path.exists(os.path.join(d, rel)):
            return os.path.join(d, rel)
        d = os.path.dirname(d)
    return None


def op_open_file(req):
    target = req["path"].strip()
    if target.startswith("file://"):
        target = target[len("file://"):]
    m = POS_RE.match(target)
    path, line = os.path.expanduser(m.group(1)), m.group(2)
    if not os.path.isabs(path):
        rel = path
        path = os.path.join(req.get("cwd") or HOME, rel)
        if not os.path.exists(path):
            path = resolve_from_transcript(req.get("file"), rel) or resolve_from_ancestors(req.get("cwd"), rel) or path
    path = os.path.normpath(path)
    if not os.path.exists(path):
        raise SystemExit("file not found: " + path)
    app = req.get("app") or "zed"
    bridge = load_config().get("openBridge")
    if sys.platform == "darwin":
        open_local(path, line, app)
    elif isinstance(bridge, dict) and bridge.get("dir") and bridge.get("root"):
        open_via_bridge(path, line, app, bridge)
    else:
        raise SystemExit("Opening files needs the open-file bridge (see docs/INSTALL.md). Use Copy path instead.")
    return {"ok": True, "path": path}


URL_RE = re.compile(r"^https?://[^\s\x00-\x1f\x7f]+$", re.I)


def op_open_url(req):
    url = str(req.get("url") or "").strip()
    if not URL_RE.match(url):
        raise SystemExit("only http(s) links can be opened")
    if sys.platform == "darwin":
        subprocess.run(["open", url], check=True, timeout=15)
        return {"ok": True}
    bridge = load_config().get("openBridge")
    if not (isinstance(bridge, dict) and bridge.get("dir") and bridge.get("root")):
        raise SystemExit("Opening links on the Mac needs the open-file bridge (see docs/INSTALL.md)")
    bridge_request(bridge, "url", url, None, "url")
    return {"ok": True}


FONTS_JS = """ObjC.import("AppKit");
function run() {
  var names = ObjC.deepUnwrap($.NSFontManager.sharedFontManager.availableFontFamilies).filter(function (n) { return n.charAt(0) !== "."; });
  names.sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
  return JSON.stringify({ok: true, fonts: names});
}"""


# Font families installed on the Mac: directly when the server is the Mac, else through the open-file bridge.
def op_fonts(req):
    if sys.platform == "darwin":
        r = subprocess.run(["osascript", "-l", "JavaScript", "-e", FONTS_JS], capture_output=True, text=True, timeout=15)
        if r.returncode != 0:
            raise SystemExit((r.stderr or "could not list fonts").strip())
        return {"fonts": json.loads(r.stdout)["fonts"]}
    bridge = load_config().get("openBridge")
    if not (isinstance(bridge, dict) and bridge.get("dir") and bridge.get("root")):
        return {"fonts": []}
    return {"fonts": bridge_request(bridge, "fonts", None, None, "fonts").get("fonts") or []}


def muxy_bin():
    for c in (shutil.which("muxy"), os.path.join(HOME, ".local", "bin", "muxy")):
        if c and os.access(c, os.X_OK):
            return c
    raise SystemExit("muxy CLI not found on the server")


def muxy_run(args, timeout=20):
    r = subprocess.run([muxy_bin()] + args, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise SystemExit((r.stderr or r.stdout or "muxy " + " ".join(args[:2]) + " failed").strip())
    return r.stdout


def muxy_list(include_ended=False):
    out = muxy_run(["session", "list", "--json"] + (["--all"] if include_ended else []))
    return json.loads(out or "[]")


def muxy_status(sid):
    try:
        s = next((x for x in muxy_list(True) if str(x.get("id")) == sid), None)
    except SystemExit:
        return None
    return s.get("status") if s is not None else "Missing"


def muxy_screen(sid, lines=60):
    out = muxy_run(["session", "read-screen", str(sid), "--lines", str(lines), "--json"])
    return json.loads(out).get("text", "")


def screen_lines(text):
    out = set()
    for line in (text or "").splitlines():
        n = norm(line)
        if len(n) >= 6 and not re.fullmatch(r"[\u2500-\u257f\-=_.·]+", n):
            out.add(n)
    return out


def op_bind(req):
    sessions = muxy_list(False)
    if not sessions:
        return {"sid": None, "reason": "no live muxy sessions on this server"}
    cwd = req.get("cwd")
    near = set(c.get("muxySessionId") for c in live_sessions(None) if c.get("cwd") == cwd)
    local = [s for s in sessions if s.get("directory") == cwd or s["id"] in near]
    sessions = local or sessions
    if len(sessions) == 1:
        return {"sid": sessions[0]["id"], "how": "only"}
    pane = screen_lines(req.get("screen"))
    shots = {}
    for s in sessions:
        try:
            shots[s["id"]] = screen_lines(muxy_screen(s["id"]))
        except SystemExit:
            shots[s["id"]] = set()
    scores = []
    for s in sessions:
        others = set()
        for o in sessions:
            if o["id"] != s["id"]:
                others |= shots[o["id"]]
        scores.append((len((pane & shots[s["id"]]) - others), s))
    scores.sort(key=lambda x: -x[0])
    best = scores[0][0]
    top = [s for sc, s in scores if sc == best]
    if best > 0 and len(top) == 1:
        return {"sid": top[0]["id"], "how": "screen", "score": best}
    pool = top if best > 0 else sessions
    same_dir = [s for s in pool if s.get("directory") == cwd]
    if len(same_dir) == 1:
        return {"sid": same_dir[0]["id"], "how": "directory", "warning": "Terminal matched by directory only"}
    pool = same_dir or pool
    claudes = [c for c in live_sessions(None) if c.get("muxySessionId") in set(s["id"] for s in pool)]
    picked = pick_by_screen(claudes, req.get("screen") or "") if claudes else None
    if picked is not None:
        return {"sid": picked["muxySessionId"], "how": "history", "warning": "Terminal matched by prompt history"}
    if claudes:
        return {"sid": claudes[0]["muxySessionId"], "how": "guess", "warning": "Could not tell terminals apart; bound to the most recently active Claude"}
    return {"sid": None, "reason": "could not match this pane to a muxy session"}


def session_summary(path):
    out = {"title": None, "prompt": None, "branch": None}
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            head = fh.read(400000).splitlines()
            fh.seek(max(0, size - 200000))
            tail = fh.read().splitlines()[1:] if size > 400000 else []
    except OSError:
        return out
    titles = {}
    for line in head + tail:
        if b'"ai-title"' in line or b'"custom-title"' in line:
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("type") == "custom-title" and e.get("customTitle"):
                titles["custom"] = e["customTitle"]
            elif e.get("type") == "ai-title" and e.get("aiTitle"):
                titles["ai"] = e["aiTitle"]
            continue
        if out["prompt"] is not None or b'"type":"user"' not in line:
            continue
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("isMeta") or e.get("isSidechain"):
            continue
        out["branch"] = out["branch"] or (e.get("gitBranch") if e.get("gitBranch") != "HEAD" else None)
        txt = PASTED_RE.sub("\n", text_of((e.get("message") or {}).get("content"))).strip()
        if txt and not txt.startswith(("<", "[Request interrupted", "Caveat:")):
            out["prompt"] = re.sub(r"\s+", " ", txt)[:200]
    out["title"] = titles.get("custom") or titles.get("ai")
    return out


# /resume picker: earlier conversations of the project, newest first.
def op_sessions(req):
    d = project_dir(req.get("cwd") or "")
    files = sorted(glob.glob(d + "/*.jsonl"), key=lambda f: -os.path.getmtime(f))
    out = []
    for f in files[:int(req.get("limit") or 60)]:
        sid = os.path.basename(f)[:-6]
        if sid == req.get("current"):
            continue
        s = session_summary(f)
        if s["prompt"] is None and s["title"] is None:
            continue
        s.update({"id": sid, "mtime": int(os.path.getmtime(f) * 1000), "size": os.path.getsize(f)})
        out.append(s)
    return {"sessions": out}


def op_save_typography(req):
    path = os.path.join(os.path.dirname(CONFIG), "typography.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump({"settings": req.get("settings") or {}, "vars": req.get("vars") or {}}, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, path)
    return {"ok": True, "path": path}


ERROR_LOG = os.path.join(STATE, "errors.log")


def op_log_error(req):
    os.makedirs(os.path.dirname(ERROR_LOG), exist_ok=True)
    with open(ERROR_LOG, "a") as fh:
        fh.write(str(req.get("text") or "").replace("\n", " ") + "\n")
    return {"ok": True}


CHANGELOG = os.path.join(CLAUDE, "cache", "changelog.md")


# The CLI keeps the Claude Code changelog here (fetched in the background by the interactive CLI), newest first.
def op_changelog(req):
    try:
        with open(CHANGELOG, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        return {"path": CHANGELOG, "versions": [], "total": 0, "missing": True}
    parts = re.split(r"^## +", text, flags=re.M)[1:]
    skip = int(req.get("skip") or 0)
    limit = int(req.get("limit") or 10)
    versions = []
    for p in parts[skip:skip + limit]:
        head, _, body = p.partition("\n")
        versions.append({"version": head.strip(), "text": body.strip()})
    return {"path": CHANGELOG, "versions": versions, "total": len(parts), "mtime": int(os.path.getmtime(CHANGELOG) * 1000)}


def install_type(path):
    real = os.path.realpath(path)
    if "/node_modules/" in real:
        return "npm-global"
    if real.startswith(os.path.join(HOME, ".local", "share", "claude")) or real.startswith(os.path.join(HOME, ".claude", "local")):
        return "native"
    if real.startswith("/opt/homebrew") or "/Cellar/" in real or "/linuxbrew/" in real:
        return "homebrew"
    return "other"


def settings_check(path):
    if not os.path.isfile(path):
        return {"path": path, "exists": False}
    try:
        with open(path) as fh:
            json.load(fh)
        return {"path": path, "exists": True, "ok": True}
    except (OSError, ValueError) as e:
        return {"path": path, "exists": True, "ok": False, "error": str(e)}


# /doctor: which claude binary the daemon would start (same order as server config.claude_bin), other installs on
# PATH, and whether the settings files parse.
def op_doctor(req):
    cwd = req.get("cwd") or HOME
    try:
        with open(CONFIG) as fh:
            configured = (json.load(fh) or {}).get("claudeBin")
    except (OSError, ValueError):
        configured = None
    chosen = None
    for cand in [configured, shutil.which("claude"), os.path.join(HOME, ".local", "bin", "claude")]:
        if cand and os.path.isfile(cand) and os.access(cand, os.X_OK):
            chosen = cand
            break
    seen = set()
    installs = []
    for d in (os.environ.get("PATH") or "").split(os.pathsep) + [os.path.join(HOME, ".local", "bin")]:
        p = os.path.join(d, "claude")
        if d and os.path.isfile(p) and os.access(p, os.X_OK) and os.path.realpath(p) not in seen:
            seen.add(os.path.realpath(p))
            installs.append({"path": p, "real": os.path.realpath(p), "type": install_type(p)})
    files = [os.path.join(CLAUDE, "settings.json"), os.path.join(CLAUDE, "settings.local.json"), os.path.join(cwd, ".claude", "settings.json"),
             os.path.join(cwd, ".claude", "settings.local.json"), os.path.join(HOME, ".claude.json"),
             "/Library/Application Support/ClaudeCode/managed-settings.json" if sys.platform == "darwin" else "/etc/claude-code/managed-settings.json"]
    return {"binary": chosen, "real": os.path.realpath(chosen) if chosen else None, "type": install_type(chosen) if chosen else None,
            "configured": configured, "installs": installs, "settings": [settings_check(f) for f in files],
            "changelog": os.path.isfile(CHANGELOG)}


def op_resolve_dir(req):
    p = os.path.expanduser(str(req.get("path") or "").strip())
    p = os.path.abspath(os.path.join(req.get("cwd") or HOME, p))
    return {"path": p, "isDir": os.path.isdir(p)}


req = json.load(sys.stdin)
# the V2 page names transcripts as ~/.claude/projects/…; every op taking `file` gets the real path
for key in ("file", "agentFile"):
    if isinstance(req.get(key), str) and req[key].startswith("~/"):
        req[key] = os.path.expanduser(req[key])
ops = {"logError": op_log_error, "bind": op_bind, "poll": op_poll, "wait": op_wait, "older": op_older, "meta": op_meta, "files": op_files, "writeImage": op_write_image, "writeExport": op_write_export, "image": op_image, "openFile": op_open_file, "openUrl": op_open_url, "fonts": op_fonts, "stats": op_stats, "agents": op_agents, "diff": op_diff, "sessions": op_sessions, "reviewSources": op_review_sources, "fileText": op_file_text, "branch": op_branch, "saveTypography": op_save_typography, "changelog": op_changelog, "doctor": op_doctor, "resolveDir": op_resolve_dir}
print(json.dumps(ops[req.get("op", "poll")](req), ensure_ascii=False))
