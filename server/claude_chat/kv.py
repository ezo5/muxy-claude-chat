"""Small values the page keeps on the server: one JSON file per key, last write wins."""
import json, os, re, uuid

import config

VALUE_MAX = 2 * 1024 * 1024
NAME_MAX = 200
UNSAFE_RE = re.compile(rb"[^a-z0-9_-]")


def root():
    return os.path.join(os.path.dirname(config.CONFIG), "kv")


# Everything but [a-z0-9_-] is escaped: no `..` or `/`, and no two keys collide on a case-insensitive disk.
def encode(name):
    if not isinstance(name, str) or not name:
        raise SystemExit("kv: scope and key must be non-empty strings")
    out = UNSAFE_RE.sub(lambda m: b"%%%02X" % m.group()[0], name.encode()).decode()
    if len(out) > NAME_MAX:
        raise SystemExit("kv: name too long")
    return out


def decode(name):
    return re.sub(rb"%([0-9A-F]{2})", lambda m: bytes([int(m.group(1), 16)]), name.encode()).decode()


def path(scope, key):
    return os.path.join(root(), encode(scope), encode(key))


def read(scope, key):
    try:
        with open(path(scope, key), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def op_get(req):
    return {"value": read(req.get("scope"), req.get("key"))}


def op_set(req):
    target = path(req.get("scope"), req.get("key"))
    data = json.dumps(req.get("value"), ensure_ascii=False).encode()
    if len(data) > VALUE_MAX:
        raise SystemExit("kv: value over 2 MB")
    folder = os.path.dirname(target)
    os.makedirs(folder, exist_ok=True)
    tmp = os.path.join(folder, ".tmp-" + uuid.uuid4().hex)
    try:
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, target)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return {"ok": True}


def op_del(req):
    try:
        os.unlink(path(req.get("scope"), req.get("key")))
    except FileNotFoundError:
        pass
    return {"ok": True}


def op_list(req):
    try:
        names = os.listdir(os.path.join(root(), encode(req.get("scope"))))
    except FileNotFoundError:
        names = []
    return {"keys": sorted(decode(n) for n in names if not n.startswith("."))}


def known_session(scope):
    if not scope.startswith("session:"):
        return True
    try:
        return os.path.isdir(config.session_dir(scope[len("session:"):]))
    except SystemExit:
        return False


# The one-time import of 2.x's values: only where the server has no value, and a chat's values only on the server that has the chat, as Muxy's storage is shared.
def op_import(req):
    counts = {"set": 0, "kept": 0, "skipped": 0}
    for item in req.get("items") or []:
        if not known_session(item.get("scope") or ""):
            counts["skipped"] += 1
        elif os.path.exists(path(item.get("scope"), item.get("key"))):
            counts["kept"] += 1
        else:
            op_set(item)
            counts["set"] += 1
    return counts


OPS = {"kvGet": op_get, "kvSet": op_set, "kvDel": op_del, "kvList": op_list, "kvImport": op_import}
