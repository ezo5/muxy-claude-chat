"""The page's one long poll: new events of the open chats, terminal mirrors, the chat overview and chat requests, in one reply.
Idle cost matters more than anything here, as it runs all day: a tick only stats a few files, reads happen when a stat changed."""
import json, os, re, time, zlib

import agent_tracker, config, kv, procs, protocol
import requests as R
import state as S

TICK_S = 0.1
TIMEOUT_MAX_MS = 25000
CAP = S.EVENTS_LIMIT_BYTES
LINES_MAX = 5000
OVERVIEW_EVERY_S = 1.0
# A stopped chat changes only when it's started again, mostly by the page itself: running chats are looked at on each check, the rest this often.
FULL_SCAN_EVERY_S = 5.0
CLOSED_HIDDEN_MS = 30 * 86400 * 1000
VERSION_RE = re.compile(rb'^\{"version": ?(\d+)')
MIRROR_RETRY_S = 1.0
TOPIC_EVERY_S = 1.0
# A call this young holds on to news that can wait, so a streaming chat costs fewer processes. Longer costs text its liveness.
HOLD_S = 0.15
# State keys that are big and seldom change: sent only when their hash differs from what the page holds.
PARTS = ("spend", "commands", "agents", "models")
# Overview versions a page can be behind and still get only the changed rows. About a minute of a streaming chat.
OVERVIEW_LOG_MAX = 64


# The optional pane-title hook's folder. Without it, nothing here looks for topics.
def topics_on():
    return os.path.isdir(os.path.join(config.HOME, ".cache", "claude-pane-title"))


# With the inode, as a timestamp is coarse: an atomic replace of the same size within one clock tick still shows.
def stat_sig(path):
    try:
        st = os.stat(path)
    except OSError:
        return None
    return [st.st_mtime_ns, st.st_size, st.st_ino]


def state_version(path):
    try:
        with open(path, "rb") as fh:
            m = VERSION_RE.match(fh.read(64))
    except OSError:
        return 0
    if m:
        return int(m.group(1))
    st = S.read_json(path)
    return int(st.get("version") or 0) if isinstance(st, dict) else 0


def read_lines(path, after, max_bytes):
    """Events past `after` up to max_bytes, with the bytes they took. A line over the whole cap could never be sent: it becomes a stub."""
    out, total, more = [], 0, False
    try:
        with open(path, "rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            fh.seek(S.find_offset(fh, after, size) if after > 0 else 0)
            for line in fh:
                if not line.endswith(b"\n"):
                    break
                m = S.SEQ_RE.match(line)
                if not m or int(m.group(1)) <= after:
                    continue
                if len(line) > CAP:
                    stub = {"type": "daemon", "subtype": "raw", "line": "event of %d bytes left out" % len(line)}
                    line = (json.dumps({"seq": int(m.group(1)), "ts": S.now_ms(), "ev": stub}) + "\n").encode()
                if len(out) >= LINES_MAX or total + len(line) > max_bytes:
                    more = True
                    break
                try:
                    out.append(json.loads(line))
                except ValueError:
                    continue
                total += len(line)
    except OSError:
        pass
    return out, total, more


class Sub:
    """One open chat of the request."""

    def __init__(self, sid, params):
        self.sid = sid
        self.d = os.path.join(config.SESSIONS, sid)
        self.events = os.path.join(self.d, "events.jsonl")
        self.state = os.path.join(self.d, "state.json")
        self.after = int(params.get("after") or 0)
        self.version = int(params.get("stateVersion") or 0)
        self.topic_at = float(params.get("topicAt") or 0)
        self.parts = params.get("parts") if isinstance(params.get("parts"), dict) else {}
        self.sig = False
        self.fresh = False
        self.asks = False
        self.tail = 0
        self.topic_next = 0
        self.topic = None
        self.topic_file = None

    # The stats come before the reads, so a write in between shows at the next tick.
    def poll(self):
        sig = (stat_sig(self.events), stat_sig(self.state))
        if sig == self.sig:
            return self.fresh
        self.sig = sig
        self.topic_file = None
        self.tail = S.last_seq(self.d)
        version = state_version(self.state)
        self.fresh = self.tail > self.after or version != self.version
        self.asks = version != self.version and bool((S.read_state(self.d) or {}).get("pending"))
        return self.fresh

    # Takes out of `st` the parts the page already holds, and says the hash of each. A first look, or a state behind the page's as from a recreated file: all of them.
    def strip_parts(self, st):
        known = self.parts if 0 < self.version < int(st.get("version") or 0) else {}
        hashes = {}
        for key in PARTS:
            if key in st:
                hashes[key] = zlib.crc32(json.dumps(st[key], sort_keys=True).encode())
                if known.get(key) == hashes[key]:
                    del st[key]
        return hashes


def iso_ms(ts):
    return int(agent_tracker.epoch(ts) * 1000) if isinstance(ts, str) and ts else None


def ask_of(request):
    name = request.get("tool_name")
    inp = request.get("input") or {}
    if name == "AskUserQuestion":
        first = (inp.get("questions") or [{}])[0]
        return first.get("question") if isinstance(first, dict) else None
    if name == "ExitPlanMode":
        return "Plan ready for review"
    if not name:
        return None
    target = request.get("title") or request.get("description") or protocol.tool_target(inp)
    return "Allow %s: %s" % (name, target) if target else "Allow %s" % name


def activity_of(st, rows):
    """{kind: need | busy | bg, tool, target, ask, req, since} from state.json, None for a chat at rest."""
    status = st.get("status")
    if status in (None, "stopped"):
        return None
    pending = st.get("pending") or []
    if pending:
        p = pending[0]
        request = p.get("request") or {}
        return {"kind": "need", "tool": request.get("tool_name"), "target": protocol.tool_target(request.get("input")), "ask": ask_of(request),
                "req": p.get("requestId"), "since": p.get("ts")}
    if status in ("busy", "starting", "stopping"):
        tools = st.get("runningTools") or []
        tool = tools[-1] if tools else {}
        return {"kind": "busy", "tool": tool.get("name"), "target": tool.get("target"), "ask": None, "req": None,
                "since": tool.get("since") or (st.get("turn") or {}).get("startedAt")}
    running = [r for r in rows if r.get("status") == "running"]
    if running:
        r = running[-1]
        return {"kind": "bg", "tool": "Agent" if r.get("kind") == "agent" else "Bash", "target": r.get("description") or r.get("command"),
                "ask": None, "req": None, "since": min(iso_ms(x.get("startTs")) or 0 for x in running) or None}
    return None


def row_needs(row):
    return (row.get("activity") or {}).get("kind") == "need"


# One that needs an answer stays, however old: the app shows it until answered.
def row_shown(row, cut):
    return not (row.get("closed") and (row.get("updatedAt") or 0) < cut and not row_needs(row))


class Overview:
    """Rows of all chats, kept on disk between calls: a watch is a new process, and only a changed state.json is parsed again."""

    def __init__(self, api):
        self.api = api
        self.path = os.path.join(config.STATE, "overview.json")
        data = S.read_json(self.path)
        data = data if isinstance(data, dict) else {}
        self.sigs = data.get("sigs") or {}
        self.rows = data.get("rows") or {}
        self.version = data.get("version")
        self.dir_sig = data.get("dir")
        # [{from: version, sids: changed on leaving it}]. The version is a hash of all sigs, so a page's version found here is what this file's rows grew from,
        # also when another page's watch wrote the file meanwhile. One that isn't found gets all rows.
        self.log = data.get("log") or []
        self.topics = topics_on()

    def age(self):
        try:
            return time.time() - os.path.getmtime(self.path)
        except OSError:
            return None

    def sig_of(self, sid):
        state = stat_sig(os.path.join(config.SESSIONS, sid, "state.json"))
        if state is None:
            return None
        sig = [state, stat_sig(kv.path("session:" + sid, "closed"))]
        if self.topics:
            sig.append(stat_sig(self.api.topic_path(self.rows.get(sid) or {"sessionId": sid})))
        return sig

    def refresh(self, sid):
        st = self.api.load_state(os.path.join(config.SESSIONS, sid))
        if not st:
            self.rows.pop(sid, None)
            return
        row = self.api.list_row(sid, st)
        row["closed"] = self.sigs[sid][1] is not None and kv.read("session:" + sid, "closed") is True
        row["activity"] = activity_of(st, self.api.agent_rows(st))
        # The row's title is the one to show, so a topic counts in it; the `list` op keeps its own shape.
        row["title"] = row["title"] or self.api.with_topic({}, st).get("topic")
        self.rows[sid] = row

    def scan(self, full):
        dir_sig = stat_sig(config.SESSIONS)
        full = full or dir_sig != self.dir_sig
        if full:
            try:
                names = os.listdir(config.SESSIONS)
            except OSError:
                names = []
        else:
            names = [sid for sid, row in self.rows.items() if row.get("status") != "stopped"]
        changed = []
        for sid in names:
            row = self.rows.get(sid)
            # A daemon that died writes nothing, so `load_state` has to repair the row. Only pid existence: `ps` is too dear here on a Mac.
            dead = row is not None and row.get("status") != "stopped" and not procs.exists(row.get("pid"))
            sig = self.sig_of(sid)
            if dead or sig != self.sigs.get(sid):
                changed.append((sid, sig))
        gone = set(self.sigs) - set(names) if full else set()
        if not changed and not gone and dir_sig == self.dir_sig and self.version is not None:
            self.touch()
            return
        self.dir_sig = dir_sig
        for sid in gone:
            self.sigs.pop(sid, None)
            self.rows.pop(sid, None)
        for sid, sig in changed:
            if sig is None:
                self.sigs.pop(sid, None)
                self.rows.pop(sid, None)
            else:
                self.sigs[sid] = sig
                self.refresh(sid)
        before = self.version
        self.version = zlib.crc32(json.dumps(self.sigs, sort_keys=True).encode())
        if before is not None and before != self.version:
            self.log = (self.log + [{"from": before, "sids": sorted(gone | {sid for sid, _ in changed})}])[-OVERVIEW_LOG_MAX:]
        self.save()

    def touch(self):
        try:
            os.utime(self.path)
        except OSError:
            pass

    def save(self):
        tmp = "%s.%d.tmp" % (self.path, os.getpid())
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump({"version": self.version, "dir": self.dir_sig, "sigs": self.sigs, "rows": self.rows, "log": self.log}, fh, ensure_ascii=False)
            os.replace(tmp, self.path)
        except OSError:
            pass

    def output(self):
        cut = S.now_ms() - CLOSED_HIDDEN_MS
        rows = [r for r in self.rows.values() if row_shown(r, cut)]
        rows.sort(key=lambda r: -(r.get("updatedAt") or 0))
        return rows

    def changes_since(self, version):
        """{rows, removed} that turn the rows of `version` into these, None when that version isn't known here."""
        sids = set()
        for entry in reversed(self.log):
            sids.update(entry["sids"])
            if entry["from"] == version:
                cut = S.now_ms() - CLOSED_HIDDEN_MS
                rows = [self.rows[sid] for sid in sorted(sids) if sid in self.rows and row_shown(self.rows[sid], cut)]
                return {"rows": rows, "removed": sorted(sids - {r["sessionId"] for r in rows})}
        return None


# The one seam to the transcript reader. Imported here, as a watch without mirrors shouldn't pay for it. `poll` rereads a whole subagent
# transcript, so it only runs after `changed` said so.
def poll_mirror(params):
    import reader
    try:
        return reader.poll(dict(params, op="poll"))
    except (Exception, SystemExit) as e:
        return {"items": [], "error": str(e)}


def mirror_changed(w):
    import reader
    return reader.changed(w)


class Mirror:
    """One terminal followed through the reader, on the `watch` its last `poll` returned."""

    def __init__(self, key, params):
        self.key = key
        self.params = params
        self.w = params.get("watch")
        self.ready = not isinstance(self.w, dict)
        self.first = self.ready
        self.next_poll = 0

    def unread(self):
        offset, size = self.params.get("offset"), self.w.get("size")
        return isinstance(offset, int) and isinstance(size, int) and offset < size - 1

    # Latched: a look may use up what it saw. A poll that changed nothing isn't repeated at every tick while the look still says changed.
    def check(self, now):
        if not self.ready and now >= self.next_poll:
            self.ready = self.unread() or bool(mirror_changed(self.w))
        return self.ready


class Watcher:
    def __init__(self, req, api):
        self.api = api
        timeout = req.get("timeoutMs")
        now = time.time()
        self.deadline = now + min(TIMEOUT_MAX_MS if timeout is None else int(timeout), TIMEOUT_MAX_MS) / 1000.0
        self.hold_until = min(now + HOLD_S, self.deadline)
        self.subs = [Sub(sid, p if isinstance(p, dict) else {}) for sid, p in (req.get("sessions") or {}).items()
                     if isinstance(sid, str) and config.SID_RE.match(sid)]
        self.mirrors = [Mirror(k, p) for k, p in (req.get("mirrors") or {}).items() if isinstance(p, dict)]
        self.seen = set(req.get("requestsSeen") or [])
        self.requests_sig = False
        self.new_requests = []
        self.client_version = req.get("overviewVersion")
        self.over = Overview(api)
        age = self.over.age()
        # Rows at most a second old do for a call right after the last one, while a chat streams.
        if age is None or age >= OVERVIEW_EVERY_S or self.over.version is None:
            self.over.scan(True)
            self.next_over = now + OVERVIEW_EVERY_S
        else:
            self.next_over = now + OVERVIEW_EVERY_S - max(0, age)
        self.next_full = now + FULL_SCAN_EVERY_S
        self.has_topics = self.over.topics

    def check_requests(self):
        sig = stat_sig(R.root())
        if sig != self.requests_sig:
            self.requests_sig = sig
            self.new_requests = [r for r in R.pending() if r.get("id") not in self.seen]
        return bool(self.new_requests)

    def check_overview(self, now):
        if now >= self.next_over:
            full = now >= self.next_full
            self.over.scan(full)
            self.next_over = now + OVERVIEW_EVERY_S
            if full:
                self.next_full = now + FULL_SCAN_EVERY_S
        return self.over.version != self.client_version

    def check_topic(self, sub, now):
        if not self.has_topics or now < sub.topic_next:
            return False
        sub.topic_next = now + TOPIC_EVERY_S
        # The state says which file; it's parsed only when it changed, as it's big.
        if sub.topic_file is None:
            st = S.read_state(sub.d)
            if not isinstance(st, dict):
                return False
            sub.topic_file = self.api.topic_path(st)
        try:
            if os.stat(sub.topic_file).st_mtime <= sub.topic_at:
                return False
        except OSError:
            return False
        sub.topic = self.api.with_topic({}, S.read_state(sub.d) or {})
        return bool(sub.topic)

    def tick(self):
        now = time.time()
        found = False
        for sub in self.subs:
            found = sub.poll() or found
            found = self.check_topic(sub, now) or found
        for m in self.mirrors:
            found = m.check(now) or found
        found = self.check_requests() or found
        return self.check_overview(now) or found

    # What must not wait for the hold: anything asking the user, a first look at a chat, and what isn't a chat's stream.
    def urgent(self):
        if self.new_requests or any(m.ready for m in self.mirrors):
            return True
        if any(s.topic or (s.fresh and (s.asks or s.version == 0)) for s in self.subs):
            return True
        if self.over.version == self.client_version:
            return False
        changes = self.over.changes_since(self.client_version)
        return changes is None or any(row_needs(r) for r in changes["rows"])

    def collect(self):
        reply = {"overviewVersion": self.over.version, "sessions": {}, "mirrors": {}}
        budget = CAP
        if self.over.version != self.client_version:
            changes = self.over.changes_since(self.client_version)
            key = "overview" if changes is None else "overviewChanges"
            reply[key] = self.over.output() if changes is None else changes
            budget -= len(json.dumps(reply[key], ensure_ascii=False))
        if self.new_requests:
            reply["requests"] = self.new_requests
            budget -= len(json.dumps(self.new_requests, ensure_ascii=False))
        for sub in self.subs:
            if state_version(sub.state) != sub.version:
                st = self.api.state_or_stub(sub.d, sub.sid)
                entry = reply["sessions"].setdefault(sub.sid, {})
                entry["parts"] = sub.strip_parts(st)
                entry["state"] = st
                budget -= len(json.dumps(st, ensure_ascii=False))
            if sub.topic:
                reply["sessions"].setdefault(sub.sid, {}).update(sub.topic)
        budget, more_mirrors = self.collect_mirrors(reply, budget)
        more_events = self.collect_events(reply, budget)
        if more_mirrors or more_events:
            reply["more"] = True
        return reply

    # Mirrors first, as a poll's size is only known afterwards. One that doesn't fit is polled again by the next call.
    def collect_mirrors(self, reply, budget):
        more = False
        for m in self.mirrors:
            if not m.ready:
                continue
            first, m.first, m.ready = m.first, False, False
            m.next_poll = time.time() + MIRROR_RETRY_S
            res = poll_mirror(m.params)
            w = res.get("watch")
            if not first and w == m.w and not res.get("items") and not res.get("more"):
                continue
            size = len(json.dumps(res, ensure_ascii=False))
            if size > budget and (reply["sessions"] or reply["mirrors"] or "overview" in reply or "overviewChanges" in reply):
                more = True
                continue
            m.w = w if isinstance(w, dict) else m.w
            more = more or res.get("more") is True
            reply["mirrors"][m.key] = res
            budget -= size
        return budget, more

    # Equal shares of what's left; what a chat didn't use goes round again, so a busy chat can't starve the others.
    def collect_events(self, reply, budget):
        wanting = [s for s in self.subs if s.tail > s.after]
        cursor = {s.sid: s.after for s in wanting}
        got = {s.sid: [] for s in wanting}
        all_wanting = list(wanting)
        while wanting and budget > 0:
            share = budget // len(wanting)
            left = []
            progressed = False
            for s in wanting:
                events, used, more = read_lines(s.events, cursor[s.sid], share)
                if events:
                    got[s.sid] += events
                    cursor[s.sid] = events[-1]["seq"]
                    budget -= used
                    progressed = True
                if more:
                    left.append(s)
            wanting = left
            if not progressed:
                break
        for s in wanting:
            reply["sessions"].setdefault(s.sid, {})["more"] = True
        for s in all_wanting:
            if got[s.sid]:
                reply["sessions"].setdefault(s.sid, {})["events"] = got[s.sid]
        return bool(wanting)


def has_news(reply):
    return bool(reply["sessions"] or reply["mirrors"] or "overview" in reply or "overviewChanges" in reply or "requests" in reply or reply.get("more"))


def op_watch(req, api):
    w = Watcher(req, api)
    news = False
    while True:
        news = w.tick() or news
        now = time.time()
        if news and (now >= w.hold_until or w.urgent()):
            reply = w.collect()
            if has_news(reply):
                return reply
            # Looked new but holds nothing, as a tail no read can reach: wait for the next change.
            news = False
            for sub in w.subs:
                sub.fresh = False
        if now >= w.deadline:
            return {"overviewVersion": w.over.version, "sessions": {}, "mirrors": {}}
        time.sleep(min(TICK_S, w.hold_until - now) if news else TICK_S)
