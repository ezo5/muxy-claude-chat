"""Notification sounds on the Mac and muxy's agent activity (background.js). A Mac server plays with afplay itself;
a remote server asks the open-file bridge (app `sound`, volume in percent as `line`); without one the caller falls back
to the page."""
import json, os, re, shutil, subprocess, sys, time

import config

NAME_RE = re.compile(r"^[A-Za-z][A-Za-z ]{0,30}$")
SOUNDS = "/System/Library/Sounds"


def op_sound(req):
    name = str(req.get("name") or "")
    if not NAME_RE.match(name):
        raise SystemExit("bad sound name")
    volume = min(max(float(req.get("volume") if req.get("volume") is not None else 0.6), 0.0), 1.0)
    if sys.platform == "darwin":
        path = os.path.join(SOUNDS, name + ".aiff")
        if not os.path.isfile(path):
            raise SystemExit("no such sound: " + name)
        subprocess.Popen(["afplay", "-v", "%.2f" % volume, path], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
        return {"played": "local"}
    bridge = config.load().get("openBridge")
    if not (isinstance(bridge, dict) and bridge.get("dir") and bridge.get("root")):
        return {"played": False, "reason": "no bridge"}
    return bridge_sound(bridge, name, max(1, int(round(volume * 100))))


def bridge_sound(bridge, name, percent):
    rid = "sound-%d-%d" % (int(time.time() * 1000), os.getpid())
    req_dir = os.path.join(bridge["dir"], "req")
    os.makedirs(req_dir, exist_ok=True)
    tmp = os.path.join(bridge["dir"], "." + rid + ".tmp")
    with open(tmp, "w") as fh:
        json.dump({"id": rid, "path": name, "line": percent, "app": "sound", "root": os.path.normpath(bridge["root"]), "ts": time.time()}, fh)
    req_path = os.path.join(req_dir, rid + ".json")
    os.rename(tmp, req_path)
    res = os.path.join(bridge["dir"], "res", rid + ".json")
    for _ in range(20):
        try:
            with open(res) as fh:
                r = json.load(fh)
        except (OSError, ValueError):
            time.sleep(0.1)
            continue
        os.unlink(res)
        return {"played": "bridge"} if r.get("ok") else {"played": False, "reason": r.get("error") or "bridge failed"}
    try:
        os.unlink(req_path)
    except OSError:
        pass
    return {"played": False, "reason": "bridge not responding"}


def muxy_bin():
    for c in (shutil.which("muxy"), os.path.join(os.path.expanduser("~"), ".local", "bin", "muxy")):
        if c and os.access(c, os.X_OK):
            return c
    return None


# `muxy activity list --json`: the events muxy notifies on (Attention / Completed per terminal session), or None.
def activity():
    exe = muxy_bin()
    if exe is None:
        return None
    try:
        r = subprocess.run([exe, "activity", "list", "--json"], capture_output=True, text=True, timeout=5)
        data = json.loads(r.stdout) if r.returncode == 0 else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None
    if not isinstance(data, dict):
        return None
    return [{"id": str(e.get("id")), "session": str(e.get("session")), "provider": e.get("provider"), "kind": e.get("kind"), "read": e.get("read") is True}
            for e in data.get("events") or [] if isinstance(e, dict)]
