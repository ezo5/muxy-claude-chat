import fcntl, json, os, re, time, uuid

SEQ_RE = re.compile(rb'^\{"seq": ?(\d+)')
EVENTS_LIMIT_BYTES = 2900 * 1024
ROTATE_BYTES = 50 * 1024 * 1024


def now_ms():
    return int(time.time() * 1000)


def read_json(path, default=None):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def write_atomic(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(obj, fh, ensure_ascii=False)
    os.replace(tmp, path)


def new_state(sid, cwd):
    return {"version": 0, "sessionId": sid, "cliSessionId": sid, "cwd": cwd, "pid": None, "cliPid": None, "cliVersion": None,
            "status": "stopped", "activity": None, "pending": [], "model": None, "effort": None, "permissionMode": None,
            "capabilities": [], "commands": [], "models": [], "contextUsage": None, "rateLimit": None, "cost": None,
            "usage": None, "lastSeq": 0, "inboxOffset": 0, "turn": {"startedAt": None, "promptId": None}, "promptQueue": [],
            "stoppedAt": None, "reason": None, "startedAt": None, "updatedAt": None, "title": None}


def read_state(d):
    return read_json(os.path.join(d, "state.json"))


def write_state(d, state):
    state["version"] = int(state.get("version") or 0) + 1
    state["updatedAt"] = now_ms()
    write_atomic(os.path.join(d, "state.json"), state)


def append_line(path, obj):
    # one write() of a full line under a lock: readers never see a torn line
    data = (json.dumps(obj, ensure_ascii=False) + "\n").encode()
    with open(path + ".lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with open(path, "ab") as fh:
            fh.write(data)
            fh.flush()


def append_inbox(d, cmd):
    rid = str(uuid.uuid4())
    append_line(os.path.join(d, "inbox.jsonl"), {"id": rid, "ts": now_ms(), "cmd": cmd})
    return rid


def append_event(d, seq, ev):
    append_line(os.path.join(d, "events.jsonl"), {"seq": seq, "ts": now_ms(), "ev": ev})


# After a rotation the live file starts empty; the seq continues from events.1.jsonl.
def last_seq(d):
    seq = file_last_seq(os.path.join(d, "events.jsonl"))
    return seq if seq else file_last_seq(os.path.join(d, "events.1.jsonl"))


def file_last_seq(path):
    try:
        with open(path, "rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            back = 65536
            while True:
                fh.seek(max(0, size - back))
                chunk = fh.read()
                end = chunk.rfind(b"\n")
                if end < 0:
                    return 0
                start = chunk.rfind(b"\n", 0, end) + 1
                # a single line (compact summary, hook output) can exceed the window: widen until it fits
                if start > 0 or back >= size:
                    break
                back *= 4
    except OSError:
        return 0
    m = SEQ_RE.match(chunk[start:end])
    return int(m.group(1)) if m else 0


def line_seq_at(fh, pos, size):
    # seq of the first full line starting at or after pos; (None, size) past the end
    fh.seek(pos)
    if pos > 0:
        fh.readline()
    start = fh.tell()
    if start >= size:
        return None, size
    m = SEQ_RE.match(fh.readline())
    return (int(m.group(1)) if m else None), start


def find_offset(fh, after, size):
    # events are appended with increasing seq, so the byte offset is searched by bisection over line starts
    lo, hi = 0, size
    while hi - lo > 4096:
        mid = (lo + hi) // 2
        seq, start = line_seq_at(fh, mid, size)
        if start >= hi:
            break
        if seq is None or seq > after:
            hi = start
        else:
            lo = start
    fh.seek(lo)
    while fh.tell() < hi:
        start = fh.tell()
        m = SEQ_RE.match(fh.readline())
        if m and int(m.group(1)) > after:
            return start
    return hi


def read_events(d, after, limit=500, max_bytes=EVENTS_LIMIT_BYTES):
    path = os.path.join(d, "events.jsonl")
    out, total, more = [], 0, False
    try:
        with open(path, "rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            fh.seek(find_offset(fh, after, size) if after > 0 else 0)
            for line in fh:
                if not line.endswith(b"\n"):
                    break
                m = SEQ_RE.match(line)
                if not m or int(m.group(1)) <= after:
                    continue
                if len(out) >= limit or total + len(line) > max_bytes:
                    more = True
                    break
                try:
                    out.append(json.loads(line))
                except ValueError:
                    continue
                total += len(line)
    except OSError:
        pass
    return out, more


def rotate_events(d, limit=ROTATE_BYTES):
    path = os.path.join(d, "events.jsonl")
    try:
        if os.path.getsize(path) <= limit:
            return False
    except OSError:
        return False
    with open(path + ".lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        os.replace(path, os.path.join(d, "events.1.jsonl"))
    return True


# Keeps only the bytes past `offset` (commands the daemon never consumed); returns the kept size.
def prune_inbox(d, offset):
    path = os.path.join(d, "inbox.jsonl")
    with open(path + ".lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            with open(path, "rb") as fh:
                fh.seek(max(0, int(offset or 0)))
                tail = fh.read()
        except OSError:
            return 0
        with open(path, "wb") as fh:
            fh.write(tail)
    return len(tail)


def read_new_lines(path, offset):
    try:
        with open(path, "rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            if size <= offset:
                return [], offset
            fh.seek(offset)
            data = fh.read(size - offset)
    except OSError:
        return [], offset
    end = data.rfind(b"\n")
    if end < 0:
        return [], offset
    lines = data[:end].split(b"\n")
    return lines, offset + end + 1
