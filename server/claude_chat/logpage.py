"""A chat opened from the end of its events log: the last turns, the few earlier events the page still needs for its state (`carry`), and pages
further back when it asks. The log isn't changed; what the page ignores is left out of the reply only. What a line does is decided in core/events.js."""
import json, re

import state as S

HEAD_RE = re.compile(rb'\{"seq": ?(\d+), "ts": ?\d+, "ev": ?\{"type": ?"(\w+)"(?:, ?"subtype": ?"(\w+)")?')
TODO_TOOL_RE = re.compile(rb'"name": ?"(?:TodoWrite|TaskCreate|TaskUpdate|TaskList)"')
TOOL_RESULT_ID_RE = re.compile(rb'"tool_use_id": ?"([^"]+)"')
TODO_TOOLS = ("TodoWrite", "TaskCreate", "TaskUpdate", "TaskList")

TAIL_BYTES = 256 * 1024
TAIL_MAX = 512 * 1024
OLDER_BYTES = 1024 * 1024
OLDER_MAX = 2 * 1024 * 1024
# A waiter gives up on a control reply after 30 s (Agent.CONTROL_TIMEOUT_MS), so an older reply can't be waited for.
CONTROL_WAIT_MS = 60000
PROMPT_KEPT_CHARS = 64

# Progress the page doesn't look at. Anything not named here is sent.
SYSTEM_IGNORED = {"thinking_tokens", "task_progress", "hook_started", "hook_progress", "hook_response", "commands_changed"}
# What resultExtra in core/events.js reads of a tool's result. The rest (whole files, mostly) is never used.
RESULT_KEYS = ("structuredPatch", "type", "stdout", "stderr", "interrupted", "backgroundTaskId", "returnCodeInterpretation", "numFiles", "numMatches", "durationMs", "status",
               "totalDurationMs", "totalTokens", "agentId", "code", "bytes", "url", "isAsync", "resolvedModel", "filenames", "answers")


class Mark:
    __slots__ = ("offset", "seq", "type", "subtype")

    def __init__(self, offset, seq, t, subtype):
        self.offset, self.seq, self.type, self.subtype = offset, seq, t, subtype


def head_of(line):
    m = HEAD_RE.match(line)
    if m:
        return int(m.group(1)), m.group(2).decode(), m.group(3).decode() if m.group(3) else None
    try:
        env = json.loads(line)
        ev = env.get("ev") or {}
        return int(env["seq"]), ev.get("type"), ev.get("subtype")
    except (ValueError, KeyError, TypeError, AttributeError):
        return None


def scan(fh, before=None):
    """Every full line before seq `before`, and which of them are about the task list."""
    marks, todos, tool_ids = [], set(), set()
    offset = 0
    for line in fh:
        if not line.endswith(b"\n"):
            break
        head = head_of(line)
        if head is not None:
            seq, t, subtype = head
            if before is not None and seq >= before:
                break
            if t == "assistant" and TODO_TOOL_RE.search(line):
                tool_ids.update(todo_tool_ids(line))
                todos.add(len(marks))
            elif t == "user" and tool_ids and any(i.decode() in tool_ids for i in TOOL_RESULT_ID_RE.findall(line)):
                todos.add(len(marks))
            marks.append(Mark(offset, seq, t, subtype))
        offset += len(line)
    return marks, todos, tool_ids


def todo_tool_ids(line):
    try:
        content = (json.loads(line)["ev"].get("message") or {}).get("content") or []
    except (ValueError, KeyError):
        return []
    return [b.get("id") for b in content if isinstance(b, dict) and b.get("name") in TODO_TOOLS]


def read_env(fh, mark):
    fh.seek(mark.offset)
    try:
        return json.loads(fh.readline())
    except ValueError:
        return None


def slim_result(r):
    if not isinstance(r, dict):
        return r
    out = {k: r[k] for k in RESULT_KEYS if k in r}
    f = r.get("file")
    if isinstance(f, dict) and f.get("numLines") is not None:
        out["file"] = {"numLines": f.get("numLines"), "totalLines": f.get("totalLines")}
    return out


def meta_reply(ev):
    """A control reply the page reads for its state; the others are in state.json, or only answer a call."""
    res = ev.get("response") or {}
    body = res.get("response") or {}
    return body.get("plugins") is not None or body.get("commands") is not None or res.get("request_id") == "init"


def stream_id(ev):
    e = ev.get("event") or {}
    return ev.get("api_message_id") or (e.get("message") or {}).get("id")


def kept(env, mark, now):
    """The envelope as the page needs it, None when the page wouldn't do anything with it."""
    ev = env.get("ev") or {}
    t = mark.type
    if t == "system" and mark.subtype in SYSTEM_IGNORED:
        return None
    if t == "control_response" and not meta_reply(ev):
        return None
    if t == "daemon" and mark.subtype == "control_result" and now - (env.get("ts") or 0) > CONTROL_WAIT_MS:
        return None
    if t == "user":
        for key in ("tool_use_result", "toolUseResult"):
            if ev.get(key) is not None:
                ev[key] = slim_result(ev[key])
    return env


def without_finished_streams(events):
    """A message's deltas go once it ended and every block it streamed has its final form. Without that (an interrupt, a question the CLI ended the turn on) the deltas are all there is.
    A block's start stays: it gives the item its place, among prompts and notices that came while it streamed, and the message's end what stops it being partial."""
    started, final, ended = {}, {}, set()
    for env in events:
        ev = env.get("ev") or {}
        if ev.get("type") == "stream_event":
            mid = stream_id(ev)
            kind = (ev.get("event") or {}).get("type")
            if kind == "content_block_start":
                started[mid] = started.get(mid, 0) + 1
            elif kind == "message_stop":
                ended.add(mid)
        elif ev.get("type") == "assistant":
            msg = ev.get("message") or {}
            mid = msg.get("id") or ev.get("uuid")
            final[mid] = final.get(mid, 0) + len(msg.get("content") or [])

    def done(env):
        ev = env.get("ev") or {}
        mid = stream_id(ev)
        kind = (ev.get("event") or {}).get("type")
        return ev.get("type") == "stream_event" and kind not in ("content_block_start", "message_stop") and mid is not None and mid in ended and final.get(mid, 0) >= started.get(mid, 0)
    return [env for env in events if not done(env)]


def size_of(env):
    return len(json.dumps(env, ensure_ascii=False))


# Before a mid-turn stop the cut must not fall inside a streaming message, whose deltas and final blocks would land in two pages.
def walk(fh, marks, enough, most):
    """Back from the end to a turn's end once there's `enough`, or to any gap between messages at `most`. Returns the page, oldest first, and the index it starts at."""
    out, total = [], 0
    now = S.now_ms()
    i = len(marks)
    while i > 0:
        i -= 1
        env = read_env(fh, marks[i])
        env = kept(env, marks[i], now) if env is not None else None
        if env is not None:
            out.append(env)
            # A finished message's deltas are dropped below, so they don't count here.
            total += size_of(env) if marks[i].type != "stream_event" else 0
        if i == 0:
            break
        prev, cur = marks[i - 1], marks[i]
        if total >= enough and prev.type == "result":
            break
        if total >= most and prev.type != "stream_event" and cur.type != "stream_event":
            break
    out.reverse()
    return without_finished_streams(out), i


def fit(carry, events):
    """The reply stays under the cap: the oldest events wait for the next page, and a line that can't fit alone becomes a stub, as in `watch`."""
    room = S.EVENTS_LIMIT_BYTES - size_of(carry) - 1024
    total = sum(size_of(e) for e in events)
    cut = 0
    while total > room and cut < len(events) - 1:
        total -= size_of(events[cut])
        cut += 1
    kept_events = events[cut:]
    if kept_events and total > room:
        stub = {"type": "daemon", "subtype": "raw", "line": "event of %d bytes left out" % total}
        kept_events[0] = {"seq": kept_events[0]["seq"], "ts": S.now_ms(), "ev": stub}
    return kept_events


def start_of(sent, events, marks, at):
    if len(sent) < len(events):
        return sent[0]["seq"]
    return marks[at].seq if at > 0 else 0


def last_where(marks, test):
    for m in reversed(marks):
        if test(m):
            return m
    return None


def is_type(t, subtype=None):
    return lambda m: m.type == t and (subtype is None or m.subtype == subtype)


def task_starts(fh, marks):
    """A task's notification, however late (one left over from an earlier process comes much later), takes its description from the start."""
    out = []
    for m in marks:
        if m.type == "system" and m.subtype == "task_started":
            env = read_env(fh, m)
            if env is not None:
                ev = env["ev"]
                env["ev"] = {k: ev[k] for k in ("type", "subtype", "task_id", "description", "is_backgrounded", "owned_by_subagent") if k in ev}
                out.append(env)
    return out


def slim_prompt(env):
    ev = env["ev"]
    ev["text"] = (ev.get("text") or "")[:PROMPT_KEPT_CHARS]
    return env


def slim_todo(env, tool_ids):
    """Only what the task list reads of a message: its calls and their results."""
    ev = env["ev"]
    msg = ev.get("message") or {}
    content = msg.get("content") if isinstance(msg.get("content"), list) else []
    if ev.get("type") == "assistant":
        blocks = [b for b in content if isinstance(b, dict) and b.get("name") in TODO_TOOLS]
        env["ev"] = {"type": "assistant", "uuid": ev.get("uuid"), "parent_tool_use_id": ev.get("parent_tool_use_id"), "message": {"id": msg.get("id"), "content": blocks}}
    else:
        blocks = [b for b in content if isinstance(b, dict) and b.get("tool_use_id") in tool_ids]
        env["ev"] = {"type": "user", "uuid": ev.get("uuid"), "parent_tool_use_id": ev.get("parent_tool_use_id"), "message": {"content": blocks}}
    return env


def slim_reply(env):
    """commands and models are in state.json, which the page applies after this."""
    body = (env["ev"].get("response") or {}).get("response")
    if isinstance(body, dict):
        body.pop("commands", None)
        body.pop("models", None)
    return env


def model_of(fh, marks):
    for m in reversed(marks):
        if m.type == "assistant":
            env = read_env(fh, m)
            model = (((env or {}).get("ev") or {}).get("message") or {}).get("model")
            if model and model != "<synthetic>":
                env["ev"] = {"type": "assistant", "uuid": env["ev"].get("uuid"), "message": {"model": model, "content": []}}
                return env
    return None


def carry_of(fh, marks, todos, tool_ids, later):
    """The events before the page that still count for the chat's state, oldest first. The page runs them apart from the conversation (Events.adopt). `later` are the marks of the page
    itself: a rewind in it also takes back task calls from before it."""
    picked = {}

    def pick(mark, slim=None):
        if mark is not None and mark.seq not in picked:
            env = read_env(fh, mark)
            if env is not None:
                picked[mark.seq] = slim(env) if slim else env

    def first_and_last(test):
        pick(next((m for m in marks if test(m)), None))
        pick(last_where(marks, test))

    first_and_last(is_type("daemon", "started"))
    first_and_last(is_type("system", "init"))
    for test in (is_type("result"), is_type("rate_limit_event"), is_type("prompt_suggestion"), is_type("system", "status"), is_type("system", "session_title_changed")):
        pick(last_where(marks, test))
    env_model = model_of(fh, marks)
    if env_model is not None:
        picked[env_model["seq"]] = env_model
    replies = [m for m in marks if m.type == "control_response"]
    last_plugins, last_init = None, None
    for m in replies:
        ev = (read_env(fh, m) or {}).get("ev") or {}
        body = (ev.get("response") or {}).get("response") or {}
        if body.get("plugins") is not None:
            last_plugins = m
        elif meta_reply(ev):
            last_init = m
    pick(last_init, slim_reply)
    pick(last_plugins, slim_reply)
    for env in task_starts(fh, marks):
        picked[env["seq"]] = env
    rewinds = [m for m in marks + later if m.type == "daemon" and m.subtype == "rewound"]
    for m in rewinds:
        pick(m)
    last_prompt = None
    for m in marks:
        if m.type == "conversation_reset":
            pick(m)
        elif m.type == "daemon" and m.subtype == "accepted":
            env = read_env(fh, m)
            ev = (env or {}).get("ev") or {}
            if ev.get("cmd") == "prompt":
                last_prompt = m
                # Earlier prompts only for what can come back to them: a command, or the target of a rewind.
                if rewinds or (ev.get("text") or "").startswith("/"):
                    picked[m.seq] = slim_prompt(env)
    # The last one also takes back the suggestion before it.
    pick(last_prompt, slim_prompt)
    for index in todos:
        if index < len(marks):
            pick(marks[index], lambda env: slim_todo(env, tool_ids))
    return [picked[seq] for seq in sorted(picked)]


def tail(path):
    """{carry, events, after, start}: subscribe from `after`; `start` is the seq `older` goes back from, 0 when the page holds the whole log."""
    try:
        with open(path, "rb") as fh:
            marks, todos, tool_ids = scan(fh)
            if not marks:
                return {"carry": [], "events": [], "after": 0, "start": 0}
            events, at = walk(fh, marks, TAIL_BYTES, TAIL_MAX)
            carry = carry_of(fh, marks[:at], todos, tool_ids, marks[at:]) if at > 0 else []
    except OSError:
        return {"carry": [], "events": [], "after": 0, "start": 0}
    sent = fit(carry, events)
    return {"carry": carry, "events": sent, "after": marks[-1].seq, "start": start_of(sent, events, marks, at)}


def older(path, before):
    """{carry, events, start}: the page before seq `before`, and `start` to go on from, 0 at the start of the log."""
    try:
        with open(path, "rb") as fh:
            marks, _, _ = scan(fh, before)
            if not marks:
                return {"carry": [], "events": [], "start": 0}
            events, at = walk(fh, marks, OLDER_BYTES, OLDER_MAX)
            carry = task_starts(fh, marks[:at])
    except OSError:
        return {"carry": [], "events": [], "start": 0}
    sent = fit(carry, events)
    return {"carry": carry, "events": sent, "start": start_of(sent, events, marks, at)}
