import json, os, re, shutil, subprocess

HOME = os.path.expanduser("~")
STATE = os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.join(HOME, ".cache"), "claude-chat")
SESSIONS = os.path.join(STATE, "sessions")
CONFIG = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.join(HOME, ".config"), "claude-chat", "config.json")
PROBED = os.path.join(os.path.dirname(CONFIG), "probed.json")
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


def runnable(path):
    return bool(path) and os.path.isfile(path) and os.access(path, os.X_OK)


# The page's probe ran in a login shell, which a detached daemon may not have: `hello` leaves what it found here.
def remember_claude(path):
    if not isinstance(path, str) or not runnable(path) or probed_claude() == path:
        return
    os.makedirs(os.path.dirname(PROBED), exist_ok=True)
    tmp = "%s.%d.tmp" % (PROBED, os.getpid())
    with open(tmp, "w") as fh:
        json.dump({"claude": path}, fh)
    os.replace(tmp, PROBED)


def probed_claude():
    try:
        with open(PROBED) as fh:
            return json.load(fh).get("claude")
    except (OSError, ValueError, AttributeError):
        return None


def login_shell_claude():
    shell = os.environ.get("SHELL") or "/bin/sh"
    try:
        out = subprocess.run([shell, "-l", "-c", "command -v claude"], capture_output=True, text=True, timeout=5, stdin=subprocess.DEVNULL).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    lines = out.strip().splitlines()
    return lines[-1].strip() if lines else None


def claude_bin(cfg=None):
    cfg = cfg or load()
    for cand in [cfg.get("claudeBin"), probed_claude(), shutil.which("claude"), os.path.join(HOME, ".local", "bin", "claude"),
                 os.path.join(HOME, ".claude", "local", "claude")]:
        if runnable(cand):
            return cand
    cand = login_shell_claude()
    return cand if runnable(cand) else None


# A script install's `#!/usr/bin/env node` needs its neighbours (nvm, Homebrew) on a PATH that may lack them.
def with_claude_dir(env, claude):
    folder = os.path.dirname(claude)
    parts = (env.get("PATH") or "").split(os.pathsep)
    if folder and folder not in parts:
        env = dict(env, PATH=os.pathsep.join([folder] + [p for p in parts if p]))
    return env


def session_dir(sid):
    if not SID_RE.match(sid or ""):
        raise SystemExit("bad sessionId")
    return os.path.join(SESSIONS, sid)
