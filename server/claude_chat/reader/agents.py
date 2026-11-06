"""Subagents and background commands of a conversation (`agents`), through the shared tracker."""
import copy, glob, json, os, re, zlib

import agent_tracker as tracker

from .common import ANSI, STATE, alive, read_json
from .sessions import live_sessions
from .transcript import tail_lines

def daemon_state_path(sid):
    return os.path.join(STATE, "sessions", sid, "state.json") if re.fullmatch(r"[A-Za-z0-9_-]{1,80}", sid or "") else None


# Chat mode: the daemon's rows decide while its CLI runs; a stopped daemon leaves the transcript to the TUI (if any).
def chat_state(path):
    st = read_json(path) if path else None
    if st and st.get("status") != "stopped" and isinstance(st.get("pid"), int) and alive(st["pid"]) and isinstance(st.get("agents"), list):
        return st
    return None


def daemon_agent_status(path, agent_id):
    st = chat_state(path)
    rows = tracker.settle([r for r in st["agents"] if r.get("agentId") == agent_id], True, (st.get("startedAt") or 0) / 1000.0) if st else []
    return rows[-1]["status"] if rows else None


def agent_status(f, daemon=None):
    inline = "#" in f
    st = None if inline else daemon_agent_status(daemon_state_path(daemon), os.path.basename(f)[6:-6])
    if st:
        return st
    main = f.split("#")[0] if inline else os.path.dirname(os.path.dirname(f)) + ".jsonl"
    a = next((a for a in session_rows(main, daemon) if a.get("inline" if inline else "file") == f), None)
    return a["status"] if a else "stopped"


def activity(b):
    if b.get("type") == "text":
        return b.get("text", "").strip().split("\n")[0][:160]
    inp = b.get("input") if isinstance(b.get("input"), dict) else {}
    for k in ("description", "file_path", "pattern", "command", "url", "query", "skill", "message"):
        v = inp.get(k)
        if isinstance(v, str) and v.strip():
            v = v.strip().split("\n")[0]
            if k == "file_path":
                v = os.path.basename(v)
            return (b.get("name") or "tool") + " · " + v[:140]
    return b.get("name") or "tool"


def agent_activity(path):
    out = {"last": None, "lastTs": None}
    for line in reversed(tail_lines(path, 200000)):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        ts = e.get("timestamp")
        if ts and (out["lastTs"] is None or ts > out["lastTs"]):
            out["lastTs"] = ts
        content = (e.get("message") or {}).get("content")
        if e.get("type") != "assistant" or not isinstance(content, list):
            continue
        blocks = [b for b in content if b.get("type") == "tool_use" or (b.get("type") == "text" and b.get("text", "").strip())]
        if blocks:
            out["last"] = activity(blocks[-1])
            break
    return out


AGENT_MARKERS = (b'"name":"Agent"', b'"name":"Task"', b'"name":"SendMessage"', b'"agentId"', b'"resumedAgentId"', b"<task-notification>",
                 b'"run_in_background":true', b'"backgroundTaskId"')
SIDECHAIN = b'"isSidechain":true'


def first_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if b.get("type") == "text")
    return ""


# A prompt as the sidecar keeps it: it's only ever compared, and a chat's prompts would be most of the file.
def prompt_key(text):
    return "%d:%x" % (len(text), zlib.crc32(text.encode("utf-8", "backslashreplace"))) if text else ""


# Old Claude Code logged subagent messages inline (isSidechain, chained by parentUuid) instead of in subagents/.
# whole: the thread's lines and its prompt as text, for showing it; otherwise what the rows need, small enough to keep.
def thread_line(roots, threads, line, whole):
    try:
        e = json.loads(line)
    except ValueError:
        return
    if not e.get("isSidechain") or not e.get("uuid"):
        return
    root = roots.get(e.get("parentUuid")) or e["uuid"]
    roots[e["uuid"]] = root
    t = threads.setdefault(root, {"prompt": None, "lines": [], "last": None, "lastTs": None})
    if whole:
        t["lines"].append(line)
    msg = e.get("message") or {}
    if t["prompt"] is None and e.get("type") == "user":
        text = first_text(msg.get("content")).strip()
        t["prompt"] = text if whole else prompt_key(text)
    if e.get("timestamp"):
        t["lastTs"] = e["timestamp"]
    content = msg.get("content")
    if e.get("type") == "assistant" and isinstance(content, list):
        blocks = [b for b in content if b.get("type") == "tool_use" or (b.get("type") == "text" and b.get("text", "").strip())]
        if blocks:
            t["last"] = activity(blocks[-1])


def inline_threads(lines):
    roots, threads = {}, {}
    for line in lines:
        if SIDECHAIN in line:
            thread_line(roots, threads, line, True)
    return threads


def output_tail(path, n=15):
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            fh.seek(max(0, size - 4000))
            text = ANSI.sub("", fh.read().decode("utf-8", "replace"))
    except OSError:
        return None
    lines = [l.rstrip() for l in text.replace("\r", "\n").split("\n") if l.strip()]
    return "\n".join(lines[-n:])


# The shared reducer's state over one transcript, fed line by line; Agent prompts and inline threads are for matching them, in a main transcript only.
class Scan:
    def __init__(self, nested, parent, saved=None):
        self.nested = nested
        self.t = tracker.Tracker.load(saved["tracker"], parent) if saved else tracker.Tracker(parent=parent)
        self.prompts = saved["prompts"] if saved else {}
        self.roots = saved["roots"] if saved else {}
        self.threads = saved["threads"] if saved else {}

    def dump(self):
        return {"tracker": self.t.dump(), "prompts": self.prompts, "roots": self.roots, "threads": self.threads}

    def feed(self, data):
        t, keys = self.t, [('"%s"' % i).encode() for i in self.t.rows]
        for line in data.splitlines():
            if SIDECHAIN in line and not self.nested:
                thread_line(self.roots, self.threads, line, False)
            if not any(m in line for m in AGENT_MARKERS) and not (b'"tool_result"' in line and any(k in line for k in keys)):
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e.get("isSidechain") and not self.nested:
                continue
            if t.feed(e):
                keys = [('"%s"' % i).encode() for i in t.rows]
            content = (e.get("message") or {}).get("content")
            for b in content if isinstance(content, list) and not self.nested else []:
                if b.get("type") == "tool_use" and b.get("name") in ("Agent", "Task"):
                    self.prompts[b.get("id")] = prompt_key(((b.get("input") or {}).get("prompt") or "").strip())


# Rows from another reducer can't be continued: a package version with changes here scans again.
def code_stamp():
    crc = 0
    for f in (__file__, tracker.__file__):
        with open(f, "rb") as fh:
            crc = zlib.crc32(fh.read(), crc)
    return crc


# What was scanned of a chat's transcripts, one file per main transcript beside the daemon's state, so it goes when the session's folder goes.
# Only for a chat with such a folder: nothing here creates one, as a folder there is a session to everyone listing them, so a terminal's transcript is
# scanned whole each time. Any state in the file is good: two ops at once each replace it whole, the later one wins, and what it lost is scanned again.
class Sidecar:
    def __init__(self, daemon, main):
        state = daemon_state_path(daemon)
        folder = os.path.dirname(state) if state else None
        self.path = os.path.join(folder, "agents-%s.json" % os.path.basename(main)[:-6]) if folder and os.path.isdir(folder) else None
        self.dirty = False
        self.code = code_stamp() if self.path else None
        data = read_json(self.path) if self.path else None
        self.entries = data["entries"] if isinstance(data, dict) and data.get("code") == self.code else {}

    def save(self):
        if not self.path or not self.dirty:
            return
        tmp = "%s.%d.tmp" % (self.path, os.getpid())
        try:
            with open(tmp, "w") as fh:
                json.dump({"code": self.code, "entries": self.entries}, fh, separators=(",", ":"))
            os.replace(tmp, self.path)
        except OSError:
            pass


ANCHOR_BYTES = 4096


def anchor(fh, offset):
    start = max(0, offset - ANCHOR_BYTES)
    fh.seek(start)
    return zlib.crc32(fh.read(offset - start))


# Whether the saved scan is of this file's start: an append keeps the inode and the bytes before it, anything else is another file.
def continues(saved, fh, st):
    if not saved or saved["ino"] != st.st_ino or st.st_size < saved["size"] or st.st_mtime_ns < saved["mtime"]:
        return False
    if st.st_size == saved["size"]:
        return st.st_mtime_ns == saved["mtime"]
    return anchor(fh, saved["offset"]) == saved["crc"]


# Scans what the sidecar hasn't seen. Only complete lines are saved; bytes after the last newline count for this reply and are read again next time.
def track(path, nested, parent=None, cache=None):
    key = "%s|%d|%s" % (path, nested, parent or "")
    saved = cache.entries.get(key) if cache else None
    try:
        with open(path, "rb") as fh:
            st = os.fstat(fh.fileno())
            if not continues(saved, fh, st):
                saved = None
            offset = saved["offset"] if saved else 0
            fh.seek(offset)
            data = fh.read()
            end = data.rfind(b"\n") + 1
            scan = Scan(nested, parent, saved)
            scan.feed(data[:end])
            size, mtime = offset + len(data), os.fstat(fh.fileno()).st_mtime_ns
            if cache and (not saved or (saved["size"], saved["mtime"]) != (size, mtime)):
                done = offset + end
                cache.entries[key] = dict(scan.dump(), ino=st.st_ino, size=size, mtime=mtime, offset=done, crc=anchor(fh, done))
                cache.dirty = True
    except OSError:
        return Scan(nested, parent)
    if end < len(data):
        scan = copy.deepcopy(scan)
        scan.feed(data[end:])
    return scan


def agent_ids(sub):
    ids = {}
    for f in glob.glob(os.path.join(sub, "agent-*.meta.json")):
        try:
            with open(f) as fh:
                ids[json.load(fh).get("toolUseId")] = os.path.basename(f)[6:-10]
        except (OSError, ValueError):
            continue
    return ids


# What only the files know: the subagent transcript and its last activity, a background command's output tail.
def enrich(a, sub, ids):
    if a["kind"] == "agent" and not a.get("agentId"):
        a["agentId"] = ids.get(a["id"])
    f = os.path.join(sub, "agent-%s.jsonl" % a["agentId"]) if a.get("agentId") else None
    if f and os.path.exists(f):
        a.update(agent_activity(f))
        a["file"] = f
    if a["kind"] == "bash" and a.get("output"):
        a["tail"] = output_tail(a["output"])
        a["last"] = (a["tail"] or "").split("\n")[-1][:160] or None
    return a


# Each agent is followed by what it spawned (rows of its own transcript); daemon rows replace the scanned ones.
def collect(path, sub, ids, nested, parent, depth, drows, out, cache):
    scan = track(path, nested, parent, cache)
    for a in scan.t.list():
        a = enrich(dict(drows.pop(a["id"], None) or a), sub, ids)
        if a.get("file") is None and a["kind"] == "agent" and not nested and scan.prompts.get(a["id"]):
            root = next((r for r, th in scan.threads.items() if th["prompt"] == scan.prompts[a["id"]]), None)
            if root is not None:
                a["inline"] = path + "#" + root
                a["last"], a["lastTs"] = scan.threads[root]["last"], scan.threads[root]["lastTs"]
        out.append(a)
        if a.get("file") and depth < 4:
            collect(a["file"], sub, ids, True, a["id"], depth + 1, drows, out, cache)


def session_rows(path, daemon=None):
    nested = os.path.basename(os.path.dirname(path)) == "subagents"
    main = os.path.dirname(os.path.dirname(path)) + ".jsonl" if nested else path
    sub = main[:-6] + "/subagents"
    ids = agent_ids(sub)
    st = chat_state(daemon_state_path(daemon))
    drows = {r["id"]: r for r in st["agents"]} if st else {}
    out = []
    cache = Sidecar(daemon, main)
    collect(path, sub, ids, nested, None, 0, drows, out, cache)
    cache.save()
    if st:
        if not nested:
            out += [enrich(dict(a), sub, ids) for a in drows.values()]
        return tracker.settle(out, True, (st.get("startedAt") or 0) / 1000.0)
    sid = os.path.basename(main)[:-6]
    live = next((s for s in live_sessions(None) if s["sessionId"] == sid), None)
    since = live["startedAt"] / 1000.0 if live and isinstance(live.get("startedAt"), (int, float)) else None
    return tracker.settle(out, live is not None, since)


def op_agents(req):
    path = req.get("file")
    return {"agents": session_rows(path, req.get("daemon")) if path and os.path.exists(path) else []}
