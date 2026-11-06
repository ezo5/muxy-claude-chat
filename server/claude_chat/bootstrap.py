# Embedded by extension/build.py as CC.BOOTSTRAP_SRC: `python3 -c <this>` with one JSON request on stdin.
import json, os, sys


def share_dir():
    return os.path.join(os.path.expanduser("~"), ".local", "share", "claude-chat")


def plain_name(name):
    return isinstance(name, str) and bool(name) and not name.startswith(".") and os.path.basename(name) == name


def files_digest(files):
    import hashlib
    h = hashlib.sha256()
    for name in sorted(files):
        h.update(name.encode() + b"\0" + files[name].encode() + b"\0")
    return h.hexdigest()


def write_package(files, version, folder):
    for name, text in files.items():
        parts = name.split("/")
        if not all(plain_name(p) for p in parts):
            raise ValueError("bad file name %r" % name)
        path = os.path.join(folder, *parts)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
    with open(os.path.join(folder, "VERSION"), "w") as fh:
        fh.write(version)


# The page's embedded package, in pieces because a request is limited. It's here, not in the package, as it brings the package; and in
# this one source, as each further source asks the user's consent again. The folder appears complete, by a rename: of two pages installing
# at once the slower one finds the work done, and a folder a daemon runs from is never written to.
def install(req):
    version, part = req.get("version"), req.get("id")
    if not plain_name(version) or not plain_name(part):
        raise ValueError("bad version or id")
    share = share_dir()
    dest = os.path.join(share, version)
    tmp = os.path.join(share, ".install-%s-%s" % (version, part))
    if os.path.isfile(os.path.join(dest, "claude_chat", "cli.py")):
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)
        return {"ok": True, "installed": False}
    os.makedirs(tmp, exist_ok=True)
    payload = os.path.join(tmp, "payload")
    offset = int(req.get("offset") or 0)
    have = os.path.getsize(payload) if os.path.exists(payload) else 0
    if offset != have:
        raise ValueError("install piece at %d, expected %d" % (offset, have))
    with open(payload, "ab") as fh:
        fh.write(req.get("data", "").encode("ascii"))
    if not req.get("last"):
        return {"ok": True}
    with open(payload, encoding="ascii") as fh:
        files = json.load(fh)
    if not version.endswith("-" + files_digest(files)[:12]):
        raise ValueError("the package doesn't match its version")
    built = os.path.join(tmp, "built")
    write_package(files, version, os.path.join(built, "claude_chat"))
    won = True
    try:
        os.rename(built, dest)
    except OSError:
        won = False
        if not os.path.isfile(os.path.join(dest, "claude_chat", "cli.py")):
            raise
    import shutil
    shutil.rmtree(tmp, ignore_errors=True)
    return {"ok": True, "installed": won}


def package_dir(req):
    # A page asks for its own package version.
    last = os.path.join(share_dir(), req["serverVersion"]) if plain_name(req.get("serverVersion")) else None
    for cand in (req.get("serverDir"), os.environ.get("CLAUDE_CHAT_HOME"), last):
        if not cand:
            continue
        for d in (cand, os.path.join(cand, "claude_chat")):
            if os.path.basename(d) == "claude_chat" and os.path.isfile(os.path.join(d, "cli.py")):
                return os.path.abspath(d)
    return None


def main():
    try:
        req = json.load(sys.stdin)
    except ValueError as e:
        print(json.dumps({"error": "bad request: %s" % e}))
        sys.exit(1)
    if req.get("op") == "serverInstall":
        try:
            print(json.dumps(install(req)))
        except (OSError, ValueError) as e:
            print(json.dumps({"error": "install failed: %s" % e}))
            sys.exit(1)
        return
    d = package_dir(req)
    if d is None and req.get("serverVersion"):
        print(json.dumps({"error": "server package %s isn't installed" % req["serverVersion"], "code": "server-missing"}))
        sys.exit(1)
    if d is None:
        print(json.dumps({"error": "claude-chat server not installed: open Claude Chat on this server once (or set CLAUDE_CHAT_HOME)"}))
        sys.exit(1)
    sys.path.insert(0, os.path.dirname(d))
    from claude_chat import cli
    cli.main(req)


main()
