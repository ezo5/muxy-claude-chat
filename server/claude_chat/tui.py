"""Interactive Claude TUIs: ~/.claude/sessions/<pid>.json (written by the CLI), SIGTERM, transcript paths."""
import glob, json, os, re, signal, time

HOME = os.path.expanduser("~")
CLAUDE = os.path.join(HOME, ".claude")
SESSIONS = os.path.join(CLAUDE, "sessions")


def alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except PermissionError:
        return True
    except Exception:
        return False


def transcript_path(cwd, sid):
    return os.path.join(CLAUDE, "projects", re.sub(r"[^A-Za-z0-9]", "-", cwd or ""), str(sid) + ".jsonl")


def live_sessions():
    out = []
    for f in glob.glob(os.path.join(SESSIONS, "*.json")):
        try:
            with open(f) as fh:
                s = json.load(fh)
        except Exception:
            continue
        pid = s.get("pid")
        if not isinstance(pid, int) or s.get("kind", "interactive") != "interactive" or not alive(pid):
            continue
        out.append({"pid": pid, "sessionId": s.get("sessionId"), "cwd": s.get("cwd"), "status": s.get("status"),
                    "waitingFor": s.get("waitingFor"), "updatedAt": s.get("updatedAt") or 0, "startedAt": s.get("startedAt")})
    out.sort(key=lambda s: -s["updatedAt"])
    return out


# pid wins (it survives /clear, which changes sessionId), then the session id, then the newest TUI in cwd.
def find(req):
    live = live_sessions()
    pid, sid, cwd = req.get("pid"), req.get("cliSessionId"), req.get("cwd")
    if pid:
        found = next((s for s in live if s["pid"] == int(pid)), None)
        if found is not None:
            return found
    if sid:
        found = next((s for s in live if s["sessionId"] == sid), None)
        if found is not None:
            return found
    if cwd and not sid and not pid:
        return next((s for s in live if s["cwd"] == cwd), None)
    return None


def op_find(req):
    return find(req)


def op_exit(req):
    s = find(req)
    if s is None:
        return {"exited": True, "found": False, "sessionId": req.get("cliSessionId")}
    pid = s["pid"]
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return {"exited": not alive(pid), "found": True, "sessionId": s["sessionId"]}
    deadline = time.time() + float(req.get("waitS") or 8)
    while time.time() < deadline and alive(pid):
        time.sleep(0.1)
    if alive(pid):
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
        time.sleep(0.2)
    return {"exited": not alive(pid), "found": True, "sessionId": s["sessionId"]}


def op_transcript_path(req):
    path = transcript_path(req.get("cwd") or "", req.get("cliSessionId") or "")
    return {"path": path, "exists": os.path.isfile(path)}


OPS = {"tuiFind": op_find, "tuiExit": op_exit, "transcriptPath": op_transcript_path}
