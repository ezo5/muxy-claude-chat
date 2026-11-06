"""Bigger binary values, sent in pieces because a request is limited: queued images."""
import base64, binascii, json, os, time

import config

CHUNK_MAX = 450 * 1024
READ_BYTES = 2 * 1024 * 1024
KEEP_S = 30 * 86400


def root():
    return os.path.join(config.STATE, "blobs")


def paths(req):
    bid = req.get("id")
    if not isinstance(bid, str) or not config.SID_RE.match(bid):
        raise SystemExit("blob: bad id")
    base = os.path.join(root(), bid)
    return base, base + ".part", base + ".meta"


# Blobs whose queue row went away with its chat.
def prune(now):
    for name in os.listdir(root()):
        p = os.path.join(root(), name)
        try:
            if now - os.path.getmtime(p) > KEEP_S:
                os.unlink(p)
        except OSError:
            pass


def op_put(req):
    done, part, meta = paths(req)
    chunk = req.get("chunk") or ""
    if len(chunk) > CHUNK_MAX:
        raise SystemExit("blob: chunk over 450 KB")
    try:
        data = base64.b64decode(chunk, validate=True)
    except (binascii.Error, ValueError, TypeError):
        raise SystemExit("blob: chunk is not base64")
    os.makedirs(root(), exist_ok=True)
    index = int(req.get("index") or 0)
    if index == 0:
        prune(time.time())
        state = {"next": 0, "size": 0, "prevSize": 0}
    else:
        try:
            with open(meta) as fh:
                state = json.load(fh)
        except (OSError, ValueError):
            raise SystemExit("blob: chunk %d of an upload that never began" % index)
    # The same chunk again means the first attempt's reply was lost: it replaces what that attempt wrote.
    if index == state["next"] - 1:
        state["next"], state["size"] = index, state["prevSize"]
    if index != state["next"]:
        raise SystemExit("blob: chunk %d out of order, expected %d" % (index, state["next"]))
    with open(part, "r+b" if index > 0 and os.path.exists(part) else "wb") as fh:
        fh.seek(state["size"])
        fh.truncate()
        fh.write(data)
    state = {"next": index + 1, "size": state["size"] + len(data), "prevSize": state["size"]}
    if req.get("last"):
        os.replace(part, done)
        if os.path.exists(meta):
            os.unlink(meta)
    else:
        with open(meta, "w") as fh:
            json.dump(state, fh)
    return {"ok": True, "size": state["size"]}


def op_get(req):
    done = paths(req)[0]
    offset = max(0, int(req.get("offset") or 0))
    try:
        with open(done, "rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            fh.seek(offset)
            data = fh.read(READ_BYTES)
    except OSError:
        raise SystemExit("blob: not found")
    return {"chunk": base64.b64encode(data).decode(), "more": offset + len(data) < size, "next": offset + len(data)}


def op_del(req):
    for p in paths(req):
        try:
            os.unlink(p)
        except FileNotFoundError:
            pass
    return {"ok": True}


OPS = {"blobPut": op_put, "blobGet": op_get, "blobDel": op_del}
