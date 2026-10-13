"""Process identity checks that work without /proc (macOS): cmdline + start time, so a reused pid is never mistaken
for our daemon or CLI."""
import os, subprocess


def ps(field, pid):
    try:
        out = subprocess.run(["ps", "-o", field + "=", "-p", str(int(pid))], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    return out.strip() or None


def cmdline(pid):
    try:
        with open("/proc/%d/cmdline" % int(pid), "rb") as fh:
            data = fh.read()
        if data:
            return data.replace(b"\0", b" ").decode("utf-8", "replace").strip()
    except (OSError, ValueError):
        pass
    return ps("command", pid)


def start_time(pid):
    try:
        with open("/proc/%d/stat" % int(pid)) as fh:
            return "proc:" + fh.read().rsplit(")", 1)[1].split()[19]
    except (OSError, ValueError, IndexError):
        pass
    t = ps("lstart", pid)
    return "ps:" + t if t else None


def exists(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except PermissionError:
        return True
    except (OSError, ValueError, TypeError):
        return False


# True only for a live process whose argv contains `marker` and (when recorded) whose start time matches.
def alive(pid, marker, started=None):
    if not pid or not marker or not exists(pid):
        return False
    cmd = cmdline(pid)
    if cmd is None or marker not in cmd:
        return False
    if started and start_time(pid) != started:
        return False
    return True
