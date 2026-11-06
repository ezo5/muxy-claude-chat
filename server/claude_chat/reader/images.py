"""Images read back from a transcript, and uploads for the CLI to read."""
import base64, json, os

IMAGE_CHUNK = 3000000


def op_write_image(req):
    d = "/tmp/claude-chat-images"
    os.makedirs(d, exist_ok=True)
    name = os.path.basename(req["name"])
    path = os.path.join(d, name)
    with open(path, "ab" if req.get("append") else "wb") as fh:
        fh.write(base64.b64decode(req["b64"]))
    return {"path": path, "size": os.path.getsize(path)}


def op_image(req):
    needle = ('"%s"' % req["id"]).encode()
    with open(req["file"].split("#")[0], "rb") as fh:
        for line in fh:
            if needle not in line:
                continue
            e = json.loads(line)
            content = (e.get("message") or {}).get("content")
            if e.get("uuid") != req["id"] or not isinstance(content, list):
                continue
            src = [b for b in content if b.get("type") == "image"][int(req.get("n") or 0)].get("source") or {}
            data = src.get("data") or ""
            off = int(req.get("offset") or 0)
            return {"media": src.get("media_type") or "image/png", "data": data[off:off + IMAGE_CHUNK], "total": len(data)}
    raise ValueError("image not found")
