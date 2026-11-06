"""Session spend from stream-json: per-model counters, per-turn cost and an attribution of input growth.

`Spend.feed(ev)` takes every CLI stdout message and returns the turn's spend for a `result` (else None); `data` is the
persisted part (`state.json` `spend`), the rest lives for one CLI process. API calls are deduplicated by `message.id`
and merged by maximum, since the `assistant` messages of a streamed call carry the usage of `message_start` and only
`message_delta` has the final output tokens.
"""
import json

HOT_TOKENS = 10000
HOT_MAX = 20
REBUILD_TOKENS = 20000
CALLS_MAX = 2000
IMAGE_TOKENS = 1600
TURN_KEYS = ("input", "cacheWrite", "cacheRead", "output")
MODEL_USAGE_KEYS = (("input", "inputTokens"), ("cacheWrite", "cacheCreationInputTokens"), ("cacheRead", "cacheReadInputTokens"), ("output", "outputTokens"))
CALL_KEYS = ("input", "write", "write5m", "write1h", "cacheRead", "output", "thinking", "webSearch", "webFetch")


def new_data():
    return {"total": {"cost": 0.0, "input": 0, "cacheWrite": 0, "cacheRead": 0, "output": 0, "turns": 0},
            "models": {}, "tools": {}, "agents": {}, "hot": []}


# message_delta usage has no cache_creation split; merging by maximum keeps the one from message_start
def call_usage(u):
    cc = u.get("cache_creation") or {}
    stu = u.get("server_tool_use") or {}
    return {"input": u.get("input_tokens") or 0, "write": u.get("cache_creation_input_tokens") or 0,
            "write5m": cc.get("ephemeral_5m_input_tokens") or 0, "write1h": cc.get("ephemeral_1h_input_tokens") or 0,
            "cacheRead": u.get("cache_read_input_tokens") or 0, "output": u.get("output_tokens") or 0,
            "thinking": (u.get("output_tokens_details") or {}).get("thinking_tokens") or 0,
            "webSearch": stu.get("web_search_requests") or 0, "webFetch": stu.get("web_fetch_requests") or 0}


def target_of(name, inp, agent_type=None):
    # the bucket a tool result's tokens are charged to: (key, label, kind)
    if name.startswith("mcp__"):
        server = name.split("__")[1] if name.count("__") >= 2 else name[5:]
        return "mcp:" + server, server, "mcp"
    if name == "Skill" and isinstance(inp.get("skill"), str):
        return "skill:" + inp["skill"], inp["skill"], "skill"
    if name == "Read" and isinstance(inp.get("file_path"), str):
        return "read:" + inp["file_path"], inp["file_path"], "read"
    if name in ("Agent", "Task"):
        t = agent_type or "general-purpose"
        return "agent:" + t, t, "agent"
    return "tool:" + name, name, "tool"


def result_size(block):
    c = block.get("content")
    if isinstance(c, str):
        return max(1, len(c) // 4)
    n = 0
    for b in c or []:
        if isinstance(b, dict) and b.get("type") == "image":
            n += IMAGE_TOKENS
        elif isinstance(b, dict):
            n += len(b.get("text") or json.dumps(b)) // 4
    return max(1, n)


class Spend:
    def __init__(self, data=None):
        self.data = data if isinstance(data, dict) and "total" in data else new_data()
        self.calls = {}
        self.tools = {}
        self.pending = {}
        self.started = set()
        self.last = {}
        self.base = {}

    def feed(self, ev):
        t = ev.get("type")
        if t == "assistant":
            msg = ev.get("message") or {}
            parent = ev.get("parent_tool_use_id")
            for b in msg.get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("id"):
                    inp = {k: v for k, v in (b.get("input") or {}).items() if k in ("subagent_type", "skill", "file_path")}
                    self.tools[b["id"]] = (b.get("name") or "", inp)
                    if b.get("name") in ("Agent", "Task"):
                        self.agent_row(inp.get("subagent_type") or "general-purpose")["runs"] += 1
            if msg.get("id") and isinstance(msg.get("usage"), dict) and msg.get("model") != "<synthetic>":
                self.call(msg["id"], msg.get("model"), parent, msg["usage"])
        elif t == "stream_event":
            e = ev.get("event") or {}
            if e.get("type") == "message_start":
                m = e.get("message") or {}
                if m.get("id") and isinstance(m.get("usage"), dict):
                    self.call(m["id"], m.get("model"), ev.get("parent_tool_use_id"), m["usage"])
            elif e.get("type") == "message_delta" and ev.get("api_message_id") and isinstance(e.get("usage"), dict):
                self.call(ev["api_message_id"], None, ev.get("parent_tool_use_id"), e["usage"])
        elif t == "user":
            content = (ev.get("message") or {}).get("content")
            for b in content if isinstance(content, list) else []:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    self.pending.setdefault(ev.get("parent_tool_use_id"), []).append((b.get("tool_use_id"), result_size(b)))
        elif t == "conversation_reset":
            self.base = {}
        elif t == "result":
            return self.turn(ev)
        return None

    def prompt(self, text):
        self.pending.setdefault(None, []).append(("prompt", max(1, len(text or "") // 4)))

    def agent_row(self, kind):
        return self.data["agents"].setdefault(kind, {"input": 0, "cacheWrite": 0, "cacheRead": 0, "output": 0, "calls": 0, "runs": 0})

    def agent_type(self, parent):
        name, inp = self.tools.get(parent, ("", {}))
        return inp.get("subagent_type") or "general-purpose" if name in ("Agent", "Task") else None

    def call(self, mid, model, parent, usage):
        u = call_usage(usage)
        seen = self.calls.get(mid)
        kind = self.agent_type(parent) if parent else None
        if seen is None:
            if len(self.calls) >= CALLS_MAX:
                for k in list(self.calls)[:CALLS_MAX // 2]:
                    del self.calls[k]
            seen = self.calls[mid] = {"model": None, "usage": dict.fromkeys(CALL_KEYS, 0)}
            self.attribute(parent, mid, u)
            if kind:
                self.agent_row(kind)["calls"] += 1
        delta = {k: max(0, u[k] - seen["usage"][k]) for k in CALL_KEYS}
        for k in CALL_KEYS:
            seen["usage"][k] = max(seen["usage"][k], u[k])
        mdelta = delta
        if seen["model"] is None and model:
            seen["model"] = model
            self.model_row(model)["calls"] += 1
            mdelta = seen["usage"]
        if seen["model"]:
            m = self.model_row(seen["model"])
            for k in ("write5m", "write1h", "thinking", "webSearch", "webFetch"):
                m[k] += mdelta[k]
        if kind:
            a = self.agent_row(kind)
            a["input"] += delta["input"]
            a["cacheWrite"] += delta["write"]
            a["cacheRead"] += delta["cacheRead"]
            a["output"] += delta["output"]

    def model_row(self, model):
        return self.data["models"].setdefault(model, {"cost": 0.0, "input": 0, "cacheWrite": 0, "cacheRead": 0, "output": 0,
                                                      "write5m": 0, "write1h": 0, "thinking": 0, "webSearch": 0, "webFetch": 0, "calls": 0})

    # Input new to this call (cache write + uncached input) is what the thread added since its previous call: that
    # call's own output, then the tool results and prompts in between (chars / 4, scaled down when they overshoot);
    # the rest is reminders and attachments, or a cache rebuild when large. A thread's first call in this process
    # carries the system prompt, tools and history.
    def attribute(self, parent, mid, u):
        fresh = u["input"] + u["write"]
        adds = self.pending.pop(parent, [])
        prev = self.calls.get(self.last.get(parent))
        self.last[parent] = mid
        if parent not in self.started:
            self.started.add(parent)
            kind = self.agent_type(parent) if parent else None
            if kind:
                self.charge("agent:" + kind, kind, "agent", fresh)
            else:
                self.charge("start", "Session start (system prompt, tools, history)", "context", fresh)
            return
        out = min(fresh, prev["usage"]["output"]) if prev is not None else 0
        self.charge("assistant", "Assistant messages", "context", out)
        fresh -= out
        est = sum(n for _, n in adds)
        spread = min(fresh, est)
        rest = fresh - spread
        if rest > 0:
            self.charge(*(("rebuild", "Cache rebuild", "context", rest) if rest > REBUILD_TOKENS else ("other", "Reminders and attachments", "context", rest)))
        left = spread
        for i, (tid, n) in enumerate(adds):
            share = left if i == len(adds) - 1 else spread * n // est
            left -= share
            if tid == "prompt":
                self.charge("prompt", "Prompts", "prompt", share)
                continue
            name, inp = self.tools.get(tid, ("", {}))
            key, label, kind = target_of(name or "tool", inp, inp.get("subagent_type"))
            self.charge(key, label, kind, share)
            if share >= HOT_TOKENS:
                hot = [h for h in self.data["hot"] if h["id"] != tid] + [{"id": tid, "label": label, "tool": name, "tokens": share}]
                hot.sort(key=lambda h: -h["tokens"])
                self.data["hot"] = hot[:HOT_MAX]

    def charge(self, key, label, kind, tokens):
        if tokens <= 0:
            return
        row = self.data["tools"].setdefault(key, {"label": label, "kind": kind, "tokens": 0, "count": 0})
        row["tokens"] += tokens
        row["count"] += 1

    # modelUsage is cumulative per CLI process and restarts after /clear, so the turn is the delta to the last result.
    def turn(self, ev):
        mu = ev.get("modelUsage")
        if not isinstance(mu, dict):
            return None
        cur = {m: dict({k: (v or {}).get(src) or 0 for k, src in MODEL_USAGE_KEYS}, cost=(v or {}).get("costUSD") or 0.0) for m, v in mu.items()}
        if any(cur.get(m, {}).get(k, 0) < b[k] for m, b in self.base.items() for k in b):
            self.base = {}
        models = {}
        for m, c in cur.items():
            b = self.base.get(m) or {}
            d = {k: c[k] - (b.get(k) or 0) for k in c}
            if any(d.values()):
                models[m] = d
        self.base = cur
        out = {"cost": 0.0, "input": 0, "cacheWrite": 0, "cacheRead": 0, "output": 0, "models": models}
        tot = self.data["total"]
        for m, d in models.items():
            row = self.model_row(m)
            for k in TURN_KEYS + ("cost",):
                row[k] += d[k]
                out[k] += d[k]
                tot[k] += d[k]
        tot["turns"] += 1
        if ev.get("uuid"):
            out["resultUuid"] = ev["uuid"]
        return out
