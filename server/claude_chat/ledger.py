"""Daily usage ledger: one JSON line per chat-mode turn in `~/.cache/claude-chat/usage/YYYY-MM-DD.jsonl` (local date).

Every daemon appends with a single `write` on an `O_APPEND` descriptor, so concurrent daemons never interleave lines;
`aggregate` reads the last N days with a byte and line budget and skips lines it cannot use.
"""
import datetime, json, os, time

import config

DIR = os.path.join(config.STATE, "usage")
DAYS_DEFAULT = 30
DAYS_MAX = 366
FILE_BYTES_MAX = 16 * 1024 * 1024
LINES_MAX = 200000
ROWS_MAX = 50
TEXT_MAX = 300
TOKEN_KEYS = ("input", "cacheWrite", "cacheRead", "output")


def day_of(ts):
    return time.strftime("%Y-%m-%d", time.localtime(ts))


def path_of(day, d=None):
    return os.path.join(d or DIR, day + ".jsonl")


def short(s):
    return s[:TEXT_MAX] if isinstance(s, str) else None


def entry(st, turn, now=None):
    models = {}
    for m, u in (turn.get("models") or {}).items():
        models[m] = {k: (u or {}).get(k) or 0 for k in TOKEN_KEYS}
        models[m]["cost"] = round((u or {}).get("cost") or 0.0, 6)
    e = {"ts": int((now if now is not None else time.time()) * 1000), "sessionId": st.get("sessionId"), "cliSessionId": st.get("cliSessionId"),
         "cwd": short(st.get("cwd")), "title": short(st.get("title")), "model": st.get("model"), "effort": st.get("effort"),
         "cost": round(turn.get("cost") or 0.0, 6), "models": models}
    for k in TOKEN_KEYS:
        e[k] = turn.get(k) or 0
    return {k: v for k, v in e.items() if v is not None}


def append(e, d=None):
    if not e.get("models"):
        return None
    d = d or DIR
    os.makedirs(d, exist_ok=True)
    path = path_of(day_of(e["ts"] / 1000.0), d)
    line = (json.dumps(e, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        os.write(fd, line)
    finally:
        os.close(fd)
    return path


def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0


def bucket(rows, key, label):
    r = rows.get(key)
    if r is None:
        r = rows[key] = {"key": key, "label": label, "cost": 0.0, "turns": 0, "input": 0, "cacheWrite": 0, "cacheRead": 0, "output": 0, "lastTs": 0}
    return r


def add(r, src, ts):
    r["cost"] += num(src.get("cost"))
    for k in TOKEN_KEYS:
        r[k] += num(src.get(k))
    r["turns"] += 1
    r["lastTs"] = max(r["lastTs"], ts)


def top(rows):
    out = sorted(rows.values(), key=lambda r: (-r["cost"], -r["lastTs"]))
    for r in out:
        r["cost"] = round(r["cost"], 6)
    return out[:ROWS_MAX], max(0, len(out) - ROWS_MAX)


def read_lines(path):
    try:
        with open(path, "rb") as fh:
            data = fh.read(FILE_BYTES_MAX)
            more = fh.read(1) != b""
    except OSError:
        return [], False
    return data.split(b"\n")[:-1], more


def aggregate(days=DAYS_DEFAULT, now=None, d=None):
    days = max(1, min(DAYS_MAX, int(days or DAYS_DEFAULT)))
    today = datetime.date.fromtimestamp(now if now is not None else time.time())
    d = d or DIR
    out_days, projects, models, chats = [], {}, {}, {}
    total = {"cost": 0.0, "turns": 0, "input": 0, "cacheWrite": 0, "cacheRead": 0, "output": 0, "lastTs": 0}
    skipped, partial, left = 0, False, LINES_MAX
    for i in range(days - 1, -1, -1):
        day = (today - datetime.timedelta(days=i)).isoformat()
        row = {"date": day, "cost": 0.0, "turns": 0, "input": 0, "cacheWrite": 0, "cacheRead": 0, "output": 0, "lastTs": 0}
        path = path_of(day, d)
        lines, more = read_lines(path) if left > 0 else ([], os.path.isfile(path))
        partial = partial or more or len(lines) > left
        for raw in lines[:left]:
            if not raw.strip():
                continue
            try:
                e = json.loads(raw)
            except ValueError:
                skipped += 1
                continue
            if not isinstance(e, dict) or not isinstance(e.get("cost"), (int, float)) or not isinstance(e.get("models"), dict):
                skipped += 1
                continue
            ts = num(e.get("ts"))
            add(row, e, ts)
            add(total, e, ts)
            cwd = e.get("cwd") if isinstance(e.get("cwd"), str) else ""
            add(bucket(projects, cwd, cwd or "(unknown)"), e, ts)
            sid = e.get("sessionId") if isinstance(e.get("sessionId"), str) else ""
            chat = bucket(chats, sid, sid or "(unknown)")
            add(chat, e, ts)
            if cwd:
                chat["cwd"] = cwd
            if isinstance(e.get("title"), str) and e["title"]:
                chat["title"] = e["title"]
            for m, u in e["models"].items():
                if isinstance(u, dict):
                    add(bucket(models, m, m), u, ts)
        left -= min(left, len(lines))
        del row["lastTs"]
        row["cost"] = round(row["cost"], 6)
        out_days.append(row)
    total["cost"] = round(total["cost"], 6)
    del total["lastTs"]
    res = {"days": out_days, "total": total, "skipped": skipped, "partial": partial}
    for name, rows in (("projects", projects), ("models", models), ("chats", chats)):
        res[name], res[name + "More"] = top(rows)
    return res

