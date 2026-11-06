"""Terminal-mode hooks. The TUI runs with `--settings <dir>/settings.json`, which adds these hooks to the user's own
(settings sources merge hooks). Each run appends one line to <dir>/events (reader `poll {hooks}`); a PermissionRequest
waits for <dir>/resp-<id> (reader `hookRespond`) and prints it as the decision, or gives up once the terminal answered
(a later prompt / turn end / result of the same tool), the TUI exited or a day passed; it then logs `_done`."""
import fcntl, json, os, shlex, shutil, signal, sys, time

import config

EVENTS = ("UserPromptSubmit", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "PermissionDenied", "Stop", "StopFailure", "SessionEnd")
ENDS_TURN = {"UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"}
ENDS_TOOL = {"PostToolUse", "PostToolUseFailure", "PermissionDenied"}
WAIT_S = 86400
KEEP_S = 7 * 86400


def now_ms():
    return int(time.time() * 1000)


def append(d, rec):
    with open(os.path.join(d, "events"), "ab") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        fh.write((json.dumps(rec, ensure_ascii=False) + "\n").encode("utf-8"))
        return fh.tell()


def record(p, cli):
    e = p.get("hook_event_name")
    rec = {"e": e, "ts": now_ms(), "cli": cli, "sid": p.get("session_id")}
    if e == "PermissionRequest":
        rec.update({"id": "%d-%d" % (rec["ts"], os.getpid()), "pid": os.getpid(), "tool": p.get("tool_name"), "input": p.get("tool_input") or {},
                    "suggestions": p.get("permission_suggestions") or [], "mode": p.get("permission_mode")})
    elif e in ENDS_TOOL:
        rec["tool"] = p.get("tool_name")
    return rec


def answered_elsewhere(d, offset, req):
    try:
        with open(os.path.join(d, "events"), "rb") as fh:
            fh.seek(offset)
            data = fh.read()
    except OSError:
        return offset, False
    end = data.rfind(b"\n") + 1
    for line in data[:end].splitlines():
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if rec.get("cli") != req["cli"]:
            continue
        if rec.get("e") in ENDS_TURN or (rec.get("e") in ENDS_TOOL and rec.get("tool") == req["tool"]):
            return offset + end, True
    return offset + end, False


def wait(d, req, offset):
    resp = os.path.join(d, "resp-" + req["id"])
    deadline = time.time() + WAIT_S
    out = ""
    try:
        while time.time() < deadline and os.getppid() == req["cli"]:
            try:
                with open(resp) as fh:
                    out = fh.read()
                os.unlink(resp)
                break
            except FileNotFoundError:
                pass
            offset, done = answered_elsewhere(d, offset, req)
            if done:
                break
            time.sleep(0.2)
    finally:
        append(d, {"e": "_done", "id": req["id"], "ts": now_ms(), "cli": req["cli"]})
    return out


def run(d):
    def bye(*_):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, bye)
    signal.signal(signal.SIGHUP, bye)
    try:
        p = json.load(sys.stdin)
    except ValueError:
        return
    if not isinstance(p, dict) or not os.path.isdir(d):
        return
    rec = record(p, os.getppid())
    offset = append(d, rec)
    if rec["e"] == "PermissionRequest":
        sys.stdout.write(wait(d, rec, offset))


def hooks_root():
    return os.path.join(config.STATE, "hooks")


def prune(root, keep):
    try:
        names = os.listdir(root)
    except OSError:
        return
    for name in names:
        path = os.path.join(root, name)
        try:
            if name != keep and time.time() - os.path.getmtime(os.path.join(path, "events")) > KEEP_S:
                shutil.rmtree(path, ignore_errors=True)
        except OSError:
            pass


# cli `tuiHooks {key}`: a fresh <dir> for one terminal-mode TUI and its settings file.
def setup(key):
    if not config.SID_RE.match(key or ""):
        raise SystemExit("bad hooks key")
    root = hooks_root()
    d = os.path.join(root, key)
    os.makedirs(d, exist_ok=True)
    prune(root, key)
    for name in os.listdir(d):
        if name.startswith("resp-"):
            os.unlink(os.path.join(d, name))
    open(os.path.join(d, "events"), "w").close()
    cmd = "exec %s %s %s" % (shlex.quote(sys.executable), shlex.quote(os.path.abspath(__file__)), shlex.quote(d))
    settings = {"hooks": {e: [{"hooks": [{"type": "command", "command": cmd, "timeout": WAIT_S if e == "PermissionRequest" else 10}]}] for e in EVENTS}}
    path = os.path.join(d, "settings.json")
    with open(path + ".tmp", "w") as fh:
        json.dump(settings, fh, indent=1)
    os.replace(path + ".tmp", path)
    return {"dir": d, "settings": path}


if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 else "")
