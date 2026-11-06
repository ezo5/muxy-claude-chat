"""A transcript as chat items: `parse`, the active branch after rewinds, and the byte-range reads behind `poll` and `older`."""
import json, os, re

from .common import ANSI, PASTED_RE, clip, text_of

TAIL = 1500000
CMD_RE = re.compile(r"<command-name>(.*?)</command-name>", re.S)
ARGS_RE = re.compile(r"<command-args>(.*?)</command-args>", re.S)
STDOUT_RE = re.compile(r"<local-command-(stdout|stderr)>(.*?)</local-command-\1>", re.S)
TASK_RE = re.compile(r"<task-notification>.*?<summary>(.*?)</summary>.*?</task-notification>", re.S)
STATUS_RE = re.compile(r"<status>(.*?)</status>")
HANDBACK_POINTER = "(its SubagentHandback call)"


def result_extra(name, r):
    if not isinstance(r, dict):
        return None
    ex = {}
    if "structuredPatch" in r and isinstance(r["structuredPatch"], list):
        hunks, total = [], 0
        for h in r["structuredPatch"]:
            lines = h.get("lines") or []
            if total > 800:
                break
            total += len(lines)
            hunks.append({"oldStart": h.get("oldStart"), "newStart": h.get("newStart"), "lines": [clip(l, 500) for l in lines[:400]]})
        ex["patch"] = hunks
        if r.get("type") == "create":
            ex["created"] = True
    if "stdout" in r or "stderr" in r:
        ex["stdout"] = clip(ANSI.sub("", r.get("stdout") or ""))
        ex["stderr"] = clip(ANSI.sub("", r.get("stderr") or ""), 4000)
        if r.get("interrupted"):
            ex["interrupted"] = True
        if r.get("backgroundTaskId"):
            ex["background"] = r.get("backgroundTaskId")
        if r.get("returnCodeInterpretation"):
            ex["rc"] = r.get("returnCodeInterpretation")
    if isinstance(r.get("file"), dict) and "numLines" in r["file"]:
        ex["numLines"] = r["file"].get("numLines")
        ex["totalLines"] = r["file"].get("totalLines")
    for k in ("numFiles", "numMatches", "durationMs", "status", "totalDurationMs", "totalTokens", "agentId", "code", "bytes", "url", "isAsync", "resolvedModel"):
        if k in r and isinstance(r[k], (int, str, bool, float)):
            ex[k] = r[k]
    if isinstance(r.get("filenames"), list):
        ex["numFiles"] = len(r["filenames"])
    if isinstance(r.get("answers"), dict):
        ex["answers"] = r["answers"]
    return ex or None


def tool_input(name, inp):
    if not isinstance(inp, dict):
        return {"value": clip(inp, 4000)}
    out = {}
    for k, v in inp.items():
        if k in ("content", "new_string", "old_string", "prompt", "plan"):
            out[k] = clip(v, 20000) if isinstance(v, str) else v
        elif k == "edits" and isinstance(v, list):
            out[k] = [{"old_string": clip(e.get("old_string", ""), 8000), "new_string": clip(e.get("new_string", ""), 8000)} for e in v[:30]]
        elif isinstance(v, str):
            out[k] = clip(v, 6000)
        elif isinstance(v, (dict, list)):
            s = json.dumps(v, ensure_ascii=False)
            out[k] = v if len(s) < 8000 else clip(s, 8000)
        else:
            out[k] = v
    return out


# typed prompts; slash commands are left out (a /compact prompt is off the chain that continues at its boundary)
def is_prompt(e):
    if e.get("type") != "user" or e.get("isMeta") or e.get("isSidechain"):
        return False
    content = (e.get("message") or {}).get("content")
    if isinstance(content, str):
        return not content.startswith(("/", "<command-", "<local-command"))
    texts = [b.get("text") or "" for b in content or [] if isinstance(b, dict) and b.get("type") == "text"]
    return bool(texts) and not texts[0].startswith(("/", "<command-", "<local-command"))


# A rewind keeps the abandoned turns in the file: the active branch runs from the newest entry (or the leaf a later
# rewound last-prompt names) up the parentUuid chain; prompts forking off that chain and everything below them are dead.
# `until` (a fork point) ends the file at that entry: it is the leaf, and the byte offset after its line is returned.
def scan_branch(path, until=None):
    parent, children, prompts, leaf, end, pos = {}, {}, [], None, None, 0
    try:
        with open(path, "rb") as fh:
            for line in fh:
                pos += len(line)
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                if e.get("type") == "last-prompt" and e.get("rewound") and e.get("leafUuid"):
                    leaf = e["leafUuid"]
                uid = e.get("uuid")
                if not uid or e.get("isSidechain"):
                    continue
                p = e.get("parentUuid") or e.get("logicalParentUuid")
                parent[uid] = p
                children.setdefault(p, []).append(uid)
                if is_prompt(e):
                    prompts.append(uid)
                if e.get("type") != "attachment":
                    leaf = uid
                if uid == until:
                    leaf, end = uid, pos
                    break
    except OSError:
        return set(), None
    chain = set()
    while leaf and leaf not in chain:
        chain.add(leaf)
        leaf = parent.get(leaf)
    dead, todo = set(), [u for u in prompts if u not in chain and parent.get(u) in chain]
    while todo:
        u = todo.pop()
        if u not in dead:
            dead.add(u)
            todo.extend(children.get(u, []))
    return dead, end


def dead_uuids(path):
    return scan_branch(path)[0]


# A subagent's SubagentHandback report (a meta user message or a queued command); the description of its Agent call
# when that is in the same chunk, else the page looks it up.
def handback(origin, uid, ts, descs):
    return {"k": "notice", "ts": ts, "id": uid, "level": "handback", "agentId": origin.get("from"), "text": descs.get(origin.get("from")),
            "detail": clip(origin.get("handbackReportText") or "", 40000)}


def parse(lines, meta, sidechain=False, dead=()):
    items, descs = [], {}
    for line in lines:
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("uuid") in dead:
            continue
        t = e.get("type")
        ts = e.get("timestamp")
        if e.get("gitBranch"):
            meta["gitBranch"] = None if e["gitBranch"] == "HEAD" else e["gitBranch"]
        if t == "assistant" and e.get("effort"):
            meta["effort"] = e["effort"]
        if t == "ai-title":
            meta["aiTitle"] = e.get("aiTitle")
            continue
        if t == "custom-title":
            meta["customTitle"] = e.get("customTitle")
            continue
        if t == "permission-mode":
            meta["permissionMode"] = e.get("permissionMode")
            continue
        if t == "attachment":
            a = e.get("attachment") or {}
            if a.get("type") == "model" and isinstance(a.get("identity"), dict):
                meta["model"] = a["identity"].get("marketingName") or a["identity"].get("modelId")
            elif a.get("type") == "queued_command" and isinstance(a.get("prompt"), str) and not e.get("isSidechain"):
                p = a["prompt"]
                m = TASK_RE.search(p)
                if (a.get("origin") or {}).get("handback"):
                    items.append(handback(a["origin"], e.get("uuid"), ts, descs))
                elif m and HANDBACK_POINTER not in p:
                    st = STATUS_RE.search(p)
                    items.append({"k": "notice", "ts": ts, "id": e.get("uuid"), "level": "task", "text": m.group(1).strip(), "status": st.group(1) if st else None})
                elif not p.lstrip().startswith("<"):
                    items.append({"k": "user", "ts": ts, "id": e.get("uuid"), "text": clip(PASTED_RE.sub("\n", p).strip(), 40000), "queued": True})
            continue
        if t == "cost-state":
            meta["cost"] = e.get("totalCostUSD")
            continue
        if t == "system":
            st = e.get("subtype")
            if st == "compact_boundary":
                items.append({"k": "notice", "ts": ts, "id": e.get("uuid"), "level": "compact", "text": "Conversation compacted"})
            elif st == "turn_duration":
                items.append({"k": "turn", "ts": ts, "id": e.get("uuid"), "ms": e.get("durationMs")})
            elif st == "local_command":
                c = e.get("content") or ""
                m = CMD_RE.search(c) if c.startswith("<command-") else None
                if m:
                    ma = ARGS_RE.search(c)
                    items.append({"k": "user", "ts": ts, "id": e.get("uuid"), "text": (m.group(1).strip() + " " + (ma.group(1).strip() if ma else "")).strip(), "command": True})
                    continue
                m = STDOUT_RE.search(c)
                out = ANSI.sub("", m.group(2)).strip() if m else ""
                if out:
                    items.append({"k": "notice", "ts": ts, "id": e.get("uuid"), "level": "command", "text": clip(out, 8000)})
            elif st in ("informational", "api_error") and e.get("content"):
                items.append({"k": "notice", "ts": ts, "id": e.get("uuid"), "level": e.get("level") or "info", "text": clip(ANSI.sub("", str(e.get("content"))), 4000)})
            continue
        if t not in ("user", "assistant") or (e.get("isSidechain") and not sidechain):
            continue
        msg = e.get("message") or {}
        content = msg.get("content")
        uid = e.get("uuid")
        if t == "user":
            if e.get("isCompactSummary"):
                items.append({"k": "notice", "ts": ts, "id": uid, "level": "compact", "text": "Conversation compacted", "detail": clip(text_of(content), 20000)})
                continue
            if isinstance(content, str):
                content = [{"type": "text", "text": content}]
            if not isinstance(content, list):
                continue
            texts, images = [], 0
            for b in content:
                bt = b.get("type")
                if bt == "tool_result":
                    c = b.get("content")
                    txt = text_of(c)
                    item = {"k": "result", "ts": ts, "tid": b.get("tool_use_id"), "err": bool(b.get("is_error")), "text": clip(ANSI.sub("", txt))}
                    ex = result_extra(None, e.get("toolUseResult"))
                    if ex:
                        item["extra"] = ex
                        if ex.get("agentId"):
                            descs[ex["agentId"]] = descs.get(b.get("tool_use_id"))
                    items.append(item)
                elif bt == "text":
                    texts.append(b.get("text", ""))
                elif bt == "image":
                    images += 1
            if (e.get("origin") or {}).get("handback"):
                items.append(handback(e["origin"], uid, ts, descs))
                continue
            if e.get("isMeta") or not (texts or images):
                continue
            txt = PASTED_RE.sub("\n", "\n".join(texts)).strip()
            s = txt
            if s.startswith("[Request interrupted"):
                items.append({"k": "notice", "ts": ts, "id": uid, "level": "interrupt", "text": "Interrupted"})
                continue
            m = CMD_RE.search(txt) if s.startswith("<command-") else None
            if m:
                name = m.group(1).strip()
                ma = ARGS_RE.search(txt)
                args = ma.group(1).strip() if ma else ""
                items.append({"k": "user", "ts": ts, "id": uid, "text": (name + " " + args).strip(), "command": True})
                continue
            m = STDOUT_RE.search(txt) if s.startswith("<local-command") else None
            if m:
                out = ANSI.sub("", m.group(2)).strip()
                if out:
                    items.append({"k": "notice", "ts": ts, "id": uid, "level": "command", "text": clip(out, 8000)})
                continue
            m = TASK_RE.search(txt) if s.startswith("<task-notification") else None
            if m and HANDBACK_POINTER in txt:
                continue
            if m:
                st = STATUS_RE.search(txt)
                items.append({"k": "notice", "ts": ts, "id": uid, "level": "task", "text": m.group(1).strip(), "status": st.group(1) if st else None})
                continue
            if s.startswith(("<local-command-caveat", "Caveat:", "<system-reminder")):
                continue
            items.append({"k": "user", "ts": ts, "id": uid, "text": clip(txt, 40000), "images": images})
        else:
            if not isinstance(content, list):
                continue
            mid = msg.get("id") or uid
            if msg.get("model") and msg.get("model") != "<synthetic>":
                meta["modelId"] = msg.get("model")
            first = len(items)
            for i, b in enumerate(content):
                bt = b.get("type")
                bid = (mid or "") + ":" + str(i)
                if bt == "text" and b.get("text", "").strip():
                    if msg.get("model") == "<synthetic>" and b["text"].startswith("No response requested"):
                        continue
                    items.append({"k": "text", "ts": ts, "id": bid, "text": b["text"], "err": bool(e.get("isApiErrorMessage")), "entryUuid": uid})
                elif bt == "thinking" and (b.get("thinking", "").strip() or e.get("thinkingDurationMs")):
                    items.append({"k": "thinking", "ts": ts, "id": bid, "text": clip(b.get("thinking", ""), 20000), "ms": e.get("thinkingDurationMs")})
                elif bt == "tool_use" and b.get("name") == "SubagentHandback" and isinstance((b.get("input") or {}).get("message"), str):
                    items.append({"k": "text", "ts": ts, "id": bid, "text": b["input"]["message"], "err": False})
                elif bt in ("tool_use", "server_tool_use"):
                    if b.get("name") in ("Agent", "Task"):
                        descs[b.get("id")] = (b.get("input") or {}).get("description")
                    items.append({"k": "tool", "ts": ts, "id": b.get("id"), "name": b.get("name"), "input": tool_input(b.get("name"), b.get("input"))})
            usage = msg.get("usage")
            if isinstance(usage, dict):
                meta["contextTokens"] = (usage.get("input_tokens") or 0) + (usage.get("cache_read_input_tokens") or 0) + (usage.get("cache_creation_input_tokens") or 0)
                # every line of one API message repeats its usage, so the page counts output tokens once per mid
                for it in items[first:]:
                    it["mid"] = mid
                    it["out"] = usage.get("output_tokens") or 0
    return items


def read_range(path, start, end, align_start):
    with open(path, "rb") as fh:
        fh.seek(start)
        data = fh.read(end - start)
    if align_start and start > 0:
        nl = data.find(b"\n")
        if nl < 0:
            return [], end, end
        start += nl + 1
        data = data[nl + 1:]
    cut = data.rfind(b"\n") + 1
    return data[:cut].splitlines(), start, start + cut


def head_meta(path):
    meta = {}
    try:
        with open(path, "rb") as fh:
            for i, line in enumerate(fh):
                if i > 400:
                    break
                if b'"ai-title"' in line or b'"custom-title"' in line or b'"permission-mode"' in line or b'"type":"model"' in line or b'"identity"' in line:
                    parse([line], meta)
    except Exception:
        pass
    return meta


def op_older(req):
    path = req["file"]
    sidechain = bool(req.get("sidechain"))
    dead, until = ((), None) if sidechain else scan_branch(path, req.get("leaf"))
    before = min(int(req["before"]), until if until is not None else os.path.getsize(path))
    start = max(0, before - int(req.get("tail") or TAIL))
    lines, start, end = read_range(path, start, before, True)
    meta = {}
    items = parse(lines, meta, sidechain, dead)
    if start == 0:
        meta.update(head_meta(path))
    return {"items": items, "start": start, "meta": meta}


def tail_lines(path, size):
    try:
        total = os.path.getsize(path)
        lines, _, _ = read_range(path, max(0, total - size), total, True)
        return lines
    except OSError:
        return []


# What the page takes from a transcript besides its items, for a chat opened without reading the transcript's history.
def tail_meta(path, size=256 * 1024):
    meta = {}
    parse([l for l in tail_lines(path, size) if b'"ai-title"' in l or b'"custom-title"' in l or b'"gitBranch"' in l], meta)
    return {k: meta[k] for k in ("aiTitle", "customTitle", "gitBranch") if k in meta}


def prompt_text(e):
    if e.get("type") != "user" or e.get("isMeta") or e.get("isSidechain") or e.get("isCompactSummary"):
        return None
    txt = text_of((e.get("message") or {}).get("content")).strip()
    if not txt or txt.startswith(("<", "[Request interrupted", "Caveat:")):
        return None
    return re.sub(r"\s+", " ", PASTED_RE.sub(" ", txt))[:160]
