"""What the reader modules share: locations, clipping, small file helpers."""
import json, os, re

HOME = os.path.expanduser("~")
CLAUDE = os.path.join(HOME, ".claude")
STATE = os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.join(HOME, ".cache"), "claude-chat")
CONFIG = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.join(HOME, ".config"), "claude-chat", "config.json")
SESSIONS = os.path.join(CLAUDE, "sessions")
CLIP = 12000
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
PASTED_RE = re.compile(r'\s*</?pasted_content(?:\s+id="[^"]*")?>[ \t]*\n?')


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


def read_json(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return None


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


def load_config():
    try:
        with open(CONFIG) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}
