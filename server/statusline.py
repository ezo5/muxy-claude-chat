import json, os, re, subprocess, sys, time

HOME = os.path.expanduser("~")
STATE = os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.join(HOME, ".cache"), "claude-chat")
CONFIG = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.join(HOME, ".config"), "claude-chat", "config.json")
SAMPLE_EVERY = 180
KEEP = 2 * 86400


def write_atomic(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = "%s.%d.tmp" % (path, os.getpid())
    with open(tmp, "w") as fh:
        fh.write(text)
    os.replace(tmp, path)


def save_status(payload, now):
    sid = str(payload.get("session_id") or "")
    if re.fullmatch(r"[0-9A-Za-z_-]+", sid):
        write_atomic(os.path.join(STATE, "statusline", sid + ".json"), json.dumps({"payload": payload, "updatedAt": now}))


def save_sample(payload, now):
    import fcntl
    rl = payload.get("rate_limits") or {}
    five = (rl.get("five_hour") or {}).get("used_percentage")
    seven = (rl.get("seven_day") or {}).get("used_percentage")
    if five is None and seven is None:
        return
    path = os.path.join(STATE, "usage-history.jsonl")
    os.makedirs(STATE, exist_ok=True)
    with open(path + ".lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            with open(path) as fh:
                lines = fh.read().splitlines()
        except OSError:
            lines = []
        rows = []
        for line in lines:
            try:
                rows.append(json.loads(line))
            except ValueError:
                pass
        if rows and now - rows[-1].get("ts", 0) < SAMPLE_EVERY:
            return
        sample = json.dumps({"ts": int(now), "five": five, "seven": seven})
        kept = [r for r in rows if r.get("ts", 0) >= now - KEEP]
        if len(kept) == len(lines):
            with open(path, "a") as fh:
                fh.write(sample + "\n")
        else:
            write_atomic(path, "".join(json.dumps(r) + "\n" for r in kept) + sample + "\n")


def default_line(payload):
    model = (payload.get("model") or {}).get("display_name") or "Claude"
    pct = (payload.get("context_window") or {}).get("used_percentage")
    return model if pct is None else "%s · ctx %d%%" % (model, pct)


def main():
    raw = sys.stdin.buffer.read()
    now = time.time()
    try:
        payload = json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        payload = None
    payload = payload if isinstance(payload, dict) else {}
    for save in (save_status, save_sample):
        try:
            save(payload, now)
        except Exception:
            pass
    try:
        with open(CONFIG) as fh:
            chain = json.load(fh).get("statuslineChain")
    except Exception:
        chain = None
    if chain:
        try:
            r = subprocess.run(chain, shell=True, input=raw, stdout=subprocess.PIPE, timeout=5)
            sys.stdout.buffer.write(r.stdout)
            return
        except Exception:
            pass
    try:
        line = default_line(payload)
    except Exception:
        line = "Claude"
    sys.stdout.buffer.write((line + "\n").encode("utf-8"))


main()
