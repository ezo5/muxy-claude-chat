"""Chats other extensions ask for. A request stays until a page takes it, so a page that wasn't open still gets it. Several pages may watch one
server: `requestDone` removes it, and only the page whose call did handles it."""
import json, os, time, uuid

import config

FIELDS = ("cwd", "prompt", "pluginDirs", "addDirs", "appendSystemPromptFile", "model", "effort", "permissionMode", "sessionId")
KEEP_S = 7 * 86400


def root():
    return os.path.join(config.STATE, "requests")


def op_request(req):
    if not isinstance(req.get("cwd"), str) or not req["cwd"]:
        raise SystemExit("request needs cwd")
    rid = str(uuid.uuid4())
    row = {k: req[k] for k in FIELDS if req.get(k) is not None}
    row.update({"id": rid, "ts": int(time.time() * 1000)})
    os.makedirs(root(), exist_ok=True)
    tmp = os.path.join(root(), "." + rid)
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(row, fh, ensure_ascii=False)
    os.replace(tmp, os.path.join(root(), rid + ".json"))
    return {"id": rid}


def op_done(req):
    rid = req.get("id")
    if not isinstance(rid, str) or not config.SID_RE.match(rid):
        raise SystemExit("requestDone: bad id")
    try:
        os.unlink(os.path.join(root(), rid + ".json"))
    except FileNotFoundError:
        return {"ok": True, "removed": False}
    return {"ok": True, "removed": True}


def pending():
    out = []
    try:
        names = os.listdir(root())
    except OSError:
        return out
    now = time.time() * 1000
    for name in names:
        if name.startswith(".") or not name.endswith(".json"):
            continue
        p = os.path.join(root(), name)
        try:
            with open(p, encoding="utf-8") as fh:
                row = json.load(fh)
            if now - row.get("ts", 0) > KEEP_S * 1000:
                os.unlink(p)
            else:
                out.append(row)
        except (OSError, ValueError):
            continue
    out.sort(key=lambda r: r.get("ts", 0))
    return out


OPS = {"request": op_request, "requestDone": op_done}
