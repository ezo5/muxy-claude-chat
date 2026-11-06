"""What the page asks first: which package answers, and with which Claude. Also removes package versions nothing uses any more."""
import json, os, re, shutil, subprocess, sys, time

import config, procs

PROTOCOL = 1
HERE = os.path.dirname(os.path.abspath(__file__))
PRUNE_EVERY_S = 3600
HOOKS_RECENT_S = 30 * 86400
STALE_INSTALL_S = 3600
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+-[0-9a-f]{12}$")


def share_dir():
    return os.path.join(config.HOME, ".local", "share", "claude-chat")


# "dev" for a checkout: only an installed copy has this file, written by the install in bootstrap.py.
def version():
    try:
        with open(os.path.join(HERE, "VERSION")) as fh:
            return fh.read().strip() or "dev"
    except OSError:
        return "dev"


def claude_version(path):
    try:
        out = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=15, stdin=subprocess.DEVNULL).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r"\d+\.\d+\.\d+", out)
    return m.group(0) if m else None


def daemon_commands():
    out = []
    try:
        names = os.listdir(config.SESSIONS)
    except OSError:
        return out
    for sid in names:
        try:
            with open(os.path.join(config.SESSIONS, sid, "state.json")) as fh:
                st = json.load(fh)
        except (OSError, ValueError):
            continue
        if st.get("status") != "stopped" and procs.exists(st.get("pid")):
            out.append(procs.cmdline(st["pid"]) or "")
    return out


# A terminal's hooks point into the package that wrote them, so they count like a daemon.
def hook_commands():
    hooks = os.path.join(config.STATE, "hooks")
    out = []
    try:
        keys = os.listdir(hooks)
    except OSError:
        return out
    for key in keys:
        p = os.path.join(hooks, key, "settings.json")
        try:
            if time.time() - os.path.getmtime(p) < HOOKS_RECENT_S:
                with open(p) as fh:
                    out.append(fh.read())
        except OSError:
            continue
    return out


def prune_due(stamp):
    try:
        if time.time() - os.path.getmtime(stamp) < PRUNE_EVERY_S:
            return False
    except OSError:
        pass
    try:
        with open(stamp, "w"):
            pass
    except OSError:
        return False
    return True


# At most once an hour; the scan of all sessions only happens when an old version is there.
def prune_versions(keep):
    share = share_dir()
    if not prune_due(os.path.join(share, ".pruned")):
        return []
    names = os.listdir(share)
    for name in names:
        p = os.path.join(share, name)
        if name.startswith(".install-") and time.time() - os.path.getmtime(p) > STALE_INSTALL_S:
            shutil.rmtree(p, ignore_errors=True)
    # Only what was installed before this one: another page may still be on a newer one.
    if not os.path.isdir(os.path.join(share, keep)):
        return []
    mine = os.path.getmtime(os.path.join(share, keep))
    old = [n for n in names if VERSION_RE.match(n) and n != keep and os.path.getmtime(os.path.join(share, n)) < mine]
    if not old:
        return []
    used = "\n".join(daemon_commands() + hook_commands())
    removed = [n for n in old if os.sep + n + os.sep not in used]
    for name in removed:
        shutil.rmtree(os.path.join(share, name), ignore_errors=True)
    return removed


def op_hello(req):
    if req.get("claudeBin"):
        config.remember_claude(req["claudeBin"])
    path = config.claude_bin()
    known = req.get("claudeVersion") if path == req.get("claudeBin") else None
    current = version()
    if current != "dev":
        prune_versions(current)
    return {"version": current, "protocol": PROTOCOL, "host": os.uname().nodename.split(".")[0], "system": os.uname().sysname, "python": "%d.%d.%d" % sys.version_info[:3],
            "claude": {"path": path, "version": known or claude_version(path)} if path else None}
