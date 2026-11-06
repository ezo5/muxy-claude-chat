"""Running TUIs, and the earlier conversations of a project (`sessions`, `searchSessions`)."""
import glob, json, os, re, time

from .common import HOME, PASTED_RE, SESSIONS, alive, project_dir, text_of
from .transcript import is_prompt


def live_sessions(cwd):
    out = []
    for f in glob.glob(os.path.join(SESSIONS, "*.json")):
        try:
            with open(f) as fh:
                s = json.load(fh)
        except Exception:
            continue
        pid = s.get("pid")
        if not isinstance(pid, int) or (cwd is not None and s.get("cwd") != cwd) or s.get("kind", "interactive") != "interactive":
            continue
        if not alive(pid):
            continue
        out.append({
            "pid": pid, "sessionId": s.get("sessionId"), "cwd": s.get("cwd"), "name": s.get("name"), "status": s.get("status"),
            "waitingFor": s.get("waitingFor"), "startedAt": s.get("startedAt"), "updatedAt": s.get("updatedAt") or 0,
            "version": s.get("version"),
        })
    out.sort(key=lambda s: -s["updatedAt"])
    return out


# Written by the optional claude-pane-title hook: a topic that follows the conversation (ai-title is set once).
def session_topic(sid):
    try:
        with open(os.path.join(HOME, ".cache", "claude-pane-title", sid + ".json")) as fh:
            return json.load(fh).get("topic")
    except Exception:
        return None


def session_summary(path):
    out = {"title": None, "prompt": None, "branch": None}
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            head = fh.read(400000).splitlines()
            fh.seek(max(0, size - 200000))
            tail = fh.read().splitlines()[1:] if size > 400000 else []
    except OSError:
        return out
    titles = {}
    for line in head + tail:
        if b'"ai-title"' in line or b'"custom-title"' in line:
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get("type") == "custom-title" and e.get("customTitle"):
                titles["custom"] = e["customTitle"]
            elif e.get("type") == "ai-title" and e.get("aiTitle"):
                titles["ai"] = e["aiTitle"]
            continue
        if out["prompt"] is not None or b'"type":"user"' not in line:
            continue
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("isMeta") or e.get("isSidechain"):
            continue
        out["branch"] = out["branch"] or (e.get("gitBranch") if e.get("gitBranch") != "HEAD" else None)
        txt = PASTED_RE.sub("\n", text_of((e.get("message") or {}).get("content"))).strip()
        if txt and not txt.startswith(("<", "[Request interrupted", "Caveat:")):
            out["prompt"] = re.sub(r"\s+", " ", txt)[:200]
    out["title"] = titles.get("custom") or titles.get("ai")
    return out


# /resume picker: earlier conversations of the project, newest first.
def op_sessions(req):
    d = project_dir(req.get("cwd") or "")
    files = sorted(glob.glob(d + "/*.jsonl"), key=lambda f: -os.path.getmtime(f))
    out = []
    for f in files[:int(req.get("limit") or 60)]:
        sid = os.path.basename(f)[:-6]
        if sid == req.get("current"):
            continue
        s = session_summary(f)
        if s["prompt"] is None and s["title"] is None:
            continue
        s.update({"id": sid, "mtime": int(os.path.getmtime(f) * 1000), "size": os.path.getsize(f)})
        out.append(s)
    return {"sessions": out}


# ("user" | "claude", text) of a typed prompt or of an answer's text blocks in the main thread.
def message_text(e):
    if e.get("isSidechain") or e.get("isMeta"):
        return None
    content = (e.get("message") or {}).get("content")
    if e.get("type") == "user" and is_prompt(e):
        return "user", PASTED_RE.sub("\n", text_of(content)).strip()
    if e.get("type") == "assistant" and isinstance(content, list):
        txt = "\n".join(b.get("text") or "" for b in content if isinstance(b, dict) and b.get("type") == "text")
        return ("claude", txt) if txt.strip() else None
    return None


def snippet(text, at, n, width=70):
    s, e = max(0, at - width), min(len(text), at + n + width)
    return ("…" if s > 0 else "") + re.sub(r"\s+", " ", text[s:e]).strip() + ("…" if e < len(text) else "")


# /resume search: prompts and answers of the project's conversations that contain `q` (case-insensitive), newest
# conversation first, one row with its newest hit each; stops at `limit` rows or after `budgetS` (`partial`).
def op_search_sessions(req):
    q = (req.get("q") or "").strip().lower()
    if len(q) < 2:
        return {"matches": [], "partial": False}
    needle = json.dumps(q, ensure_ascii=False)[1:-1].encode("utf-8")
    files = sorted(glob.glob(project_dir(req.get("cwd") or "") + "/*.jsonl"), key=lambda f: -os.path.getmtime(f))
    deadline = time.time() + float(req.get("budgetS") or 4)
    limit = int(req.get("limit") or 30)
    out = []
    for f in files:
        sid = os.path.basename(f)[:-6]
        if sid == req.get("current"):
            continue
        if len(out) >= limit or time.time() > deadline:
            return {"matches": out, "partial": True}
        best, hits = None, 0
        try:
            with open(f, "rb") as fh:
                for line in fh:
                    if needle not in line.lower():
                        continue
                    try:
                        m = message_text(json.loads(line))
                    except Exception:
                        continue
                    at = m[1].lower().find(q) if m else -1
                    if at >= 0:
                        hits += 1
                        best = {"role": m[0], "snippet": snippet(m[1], at, len(q))}
        except OSError:
            continue
        if best is None:
            continue
        s = session_summary(f)
        s.update(best, id=sid, hits=hits, mtime=int(os.path.getmtime(f) * 1000), size=os.path.getsize(f))
        out.append(s)
    return {"matches": out, "partial": False}
