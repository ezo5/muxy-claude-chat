import json, os, re, shutil

HOME = os.path.expanduser("~")
STATE = os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.join(HOME, ".cache"), "claude-chat")
SESSIONS = os.path.join(STATE, "sessions")
CONFIG = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.join(HOME, ".config"), "claude-chat", "config.json")
DEFAULTS = {"claudeBin": None, "idleStopMs": 6 * 3600 * 1000, "stopWaitMs": 60000, "stopKillMs": 10000, "extraArgs": []}
SID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")


def load():
    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG) as fh:
            cfg.update(json.load(fh))
    except (OSError, ValueError):
        pass
    return cfg


def claude_bin(cfg=None):
    cfg = cfg or load()
    for cand in [cfg.get("claudeBin"), shutil.which("claude"), os.path.join(HOME, ".local", "bin", "claude")]:
        if cand and os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return None


def session_dir(sid):
    if not SID_RE.match(sid or ""):
        raise SystemExit("bad sessionId")
    return os.path.join(SESSIONS, sid)
