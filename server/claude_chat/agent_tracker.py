"""Subagents and background commands of one conversation: the single reducer behind the daemon's state.json rows and
the reader's transcript scan. feed() takes transcript entries and stream-json events alike (pure, stdlib only; the
reader embeds this file, see extension/build.py)."""
import datetime, re

TASK_ID_RE = re.compile(r"<task-id>(.*?)</task-id>")
TOOL_ID_RE = re.compile(r"<tool-use-id>(.*?)</tool-use-id>")
STATUS_RE = re.compile(r"<status>(.*?)</status>")
DURATION_RE = re.compile(r"<duration_ms>(\d+)</duration_ms>")
BG_ID_RE = re.compile(r"running in background with ID: (\w+)")
OUTPUT_RE = re.compile(r"Output is being written to: (\S+)")
AGENT_ID_RE = re.compile(r"agentId: (\w+)")
REJECTED_RE = re.compile(r"^\s*(The user doesn't want to proceed|\[Request interrupted)")
STATUS = {"completed": "done", "failed": "error", "killed": "stopped", "stopped": "stopped"}


def iso(ms):
    return datetime.datetime.fromtimestamp(ms / 1000.0, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def epoch(ts):
    try:
        return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        return None


def text_of(content):
    if isinstance(content, str):
        return content
    return "\n".join(b.get("text") or "" for b in content or [] if isinstance(b, dict) and b.get("type") == "text")


class Tracker:
    def __init__(self, rows=None, parent=None):
        self.rows = {}
        self.alias = {}
        self.seen = set()
        self.parent = parent
        self.changed = False
        for r in rows or []:
            self.index(dict(r))

    def index(self, row):
        self.rows[row["id"]] = row
        for k in ("agentId", "taskId"):
            if row.get(k):
                self.alias[row[k]] = row["id"]
        return row

    def list(self):
        return list(self.rows.values())

    def find(self, *ids):
        for i in ids:
            if i in self.rows:
                return self.rows[i]
            if i in self.alias:
                return self.rows[self.alias[i]]
        return None

    def set(self, row, **kw):
        for k, v in kw.items():
            if row.get(k) != v:
                row[k] = v
                self.changed = True
        for k in ("agentId", "taskId"):
            if kw.get(k):
                self.alias[kw[k]] = row["id"]

    def run(self, row, ts):
        if row["status"] != "running":
            self.set(row, status="running", startTs=ts, endTs=None, ms=None)

    def finish(self, row, status, ts, ms=None):
        self.set(row, status=status, endTs=ts)
        if ms:
            self.set(row, ms=int(ms))

    # True when a row changed; ts stands in for entries without a timestamp (stream task events)
    def feed(self, e, ts=None):
        self.changed = False
        ts = e.get("timestamp") or ts
        t = e.get("type")
        if t == "system" and e.get("subtype") in ("task_started", "task_updated", "task_notification"):
            self.task_event(e, ts)
        elif t == "queue-operation" and e.get("operation") == "enqueue":
            self.note(e.get("content"), ts)
        elif t == "attachment":
            self.note((e.get("attachment") or {}).get("prompt"), ts)
        elif t in ("assistant", "user"):
            content = (e.get("message") or {}).get("content")
            if isinstance(content, str):
                self.note(content, ts)
            for b in content if isinstance(content, list) else []:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    self.tool_use(b, e.get("parent_tool_use_id"), ts)
                elif isinstance(b, dict) and b.get("type") == "tool_result":
                    self.tool_result(b, e, ts)
        return self.changed

    def tool_use(self, b, parent, ts):
        tid, name = b.get("id"), b.get("name")
        inp = b.get("input") if isinstance(b.get("input"), dict) else {}
        if not tid or tid in self.rows:
            return
        row = {"id": tid, "parent": parent or self.parent, "agentId": None, "taskId": None, "status": "running", "startTs": ts, "endTs": None, "ms": None,
               "background": inp.get("run_in_background") in (True, "true")}
        if name in ("Agent", "Task"):
            row.update(kind="agent", description=inp.get("description") or "", type=inp.get("subagent_type") or "general-purpose")
        elif name == "Bash" and row["background"]:
            cmd = str(inp.get("command") or "")
            row.update(kind="bash", description=inp.get("description") or cmd.strip().split("\n")[0][:120], type="bash", command=cmd[:1000], output=None)
        else:
            target = self.find(inp.get("to")) if name == "SendMessage" else None
            if target is not None:
                self.alias[tid] = target["id"]
            return
        self.index(row)
        self.changed = True

    def tool_result(self, b, e, ts):
        tid = b.get("tool_use_id")
        res = e.get("tool_use_result", e.get("toolUseResult"))
        r = res if isinstance(res, dict) else {}
        row = self.rows.get(tid)
        if row is None:
            # SendMessage that woke a finished agent up again
            target = self.find(r.get("resumedAgentId"))
            if target is not None:
                self.alias[tid] = target["id"]
                self.run(target, ts)
            return
        text = text_of(b.get("content"))
        if b.get("is_error"):
            rejected = REJECTED_RE.match(text) or (isinstance(res, str) and "rejected" in res)
            self.finish(row, "stopped" if rejected else "error", ts)
        elif row["kind"] == "bash":
            m = BG_ID_RE.search(text)
            if r.get("backgroundTaskId") or m:
                out = OUTPUT_RE.search(text)
                self.set(row, taskId=r.get("backgroundTaskId") or m.group(1), output=out.group(1) if out else None)
            else:
                self.finish(row, "done", ts)
        else:
            m = AGENT_ID_RE.search(text)
            agent_id = r.get("agentId") or (m.group(1) if m else None)
            if agent_id:
                self.set(row, agentId=agent_id)
            if r.get("status") == "async_launched" or text.startswith("Async agent launched"):
                self.set(row, background=True)
            else:
                self.finish(row, "done", ts, r.get("totalDurationMs"))

    def task_event(self, e, ts):
        st, task_id = e.get("subtype"), e.get("task_id")
        row = self.find(e.get("tool_use_id"), task_id)
        if row is None:
            return
        if st == "task_started":
            if e.get("tool_use_id") and e["tool_use_id"] != row["id"]:
                self.alias[e["tool_use_id"]] = row["id"]
            self.set(row, taskId=task_id)
            if e.get("task_type") == "local_agent":
                self.set(row, agentId=task_id)
            if e.get("is_backgrounded"):
                self.set(row, background=True)
            self.run(row, ts)
        elif st == "task_updated":
            patch = e.get("patch") or {}
            if patch.get("status") and patch["status"] != "running":
                self.finish(row, STATUS.get(patch["status"], "done"), iso(patch["end_time"]) if patch.get("end_time") else ts)
        elif self.once((task_id, e.get("run_id") or e.get("uuid"))):
            self.finish(row, STATUS.get(e.get("status") or "completed", "done"), ts, (e.get("usage") or {}).get("duration_ms"))

    # <task-notification> as a user message, a queued command or a queue operation
    def note(self, text, ts):
        if not isinstance(text, str) or "<task-notification>" not in text:
            return
        task, tool = TASK_ID_RE.search(text), TOOL_ID_RE.search(text)
        row = self.find(tool and tool.group(1), task and task.group(1))
        d = DURATION_RE.search(text)
        # one notification is logged up to four times (queue, delivery); the first copy carries the finish time
        if row is None or not self.once((task and task.group(1), d.group(1) if d else text)):
            return
        st = STATUS_RE.search(text)
        self.finish(row, STATUS.get(st.group(1) if st else "", "done"), ts, d and d.group(1))

    def once(self, key):
        if key in self.seen:
            return False
        self.seen.add(key)
        return True


# The one liveness rule, applied when rows are read: a row still running belongs to a dead CLI process, or to an
# earlier one than the process now running (`since`, epoch seconds), cannot finish any more.
def settle(rows, alive, since=None):
    out = []
    for r in rows:
        if r.get("status") == "running" and (not alive or (since and (epoch(r.get("startTs")) or since) < since)):
            r = dict(r, status="stopped", endTs=r.get("lastTs") or r.get("endTs"))
        out.append(r)
    return out


def counts(rows):
    agents = [r for r in rows if r.get("kind") == "agent"]
    running = sum(1 for r in agents if r["status"] == "running")
    return {"running": running, "done": len(agents) - running}
