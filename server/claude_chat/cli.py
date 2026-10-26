#!/usr/bin/env python3
import fcntl, json, os, signal, subprocess, sys, time, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import agent_tracker, config, procs
import state as S
import tui

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
        S.rotate_events(d)
        args = {"sessionId": sid, "cliSessionId": cli_sid, "cwd": os.path.abspath(cwd), "resume": bool(resume),
                "fork": bool(req.get("forkSession")), "partial": req.get("partial", True) is not False,
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


# Written by the optional claude-pane-title hook (Haiku): a topic that follows the conversation.
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
        out.append({"sessionId": sid, "cwd": st.get("cwd"), "status": st.get("status"), "pid": st.get("pid"), "lastSeq": st.get("lastSeq"),
                    "updatedAt": st.get("updatedAt"), "model": st.get("model"), "reason": st.get("reason"), "cliSessionId": st.get("cliSessionId"),
                    "lastSkill": st.get("lastSkill"), "agents": agent_tracker.counts(agent_rows(st))})
    out.sort(key=lambda s: -(s["updatedAt"] or 0))
    return {"sessions": out}


OPS = {"start": op_start, "stop": op_stop, "send": op_send, "sendChunk": op_send_chunk, "respond": op_respond, "interrupt": op_interrupt,
       "control": op_control, "events": op_events, "wait": op_wait, "state": op_state, "list": op_list, "prune": op_prune}
OPS.update(tui.OPS)


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
