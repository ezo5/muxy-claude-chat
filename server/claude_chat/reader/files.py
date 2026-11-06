"""Paths and files: `@` completion, opening files and links, export, fonts."""
import glob, json, os, re, shutil, subprocess, sys, time

from .common import HOME, load_config
from .git import live_cwd

def op_files(req):
    cwd = live_cwd(req.get("cwd") or ".")
    q = (req.get("q") or "").lower()
    files = []
    try:
        r = subprocess.run(["git", "ls-files", "-co", "--exclude-standard"], cwd=cwd, capture_output=True, text=True, timeout=8)
        if r.returncode == 0:
            files = r.stdout.splitlines()
    except Exception:
        pass
    if not files:
        for root, dirs, names in os.walk(cwd):
            dirs[:] = [x for x in dirs if not x.startswith(".") and x not in ("node_modules", "build", "dist", "target")]
            for n in names:
                files.append(os.path.relpath(os.path.join(root, n), cwd))
            if len(files) > 50000:
                break
    dirs = set()
    for f in files:
        p = os.path.dirname(f)
        while p and p not in dirs:
            dirs.add(p)
            p = os.path.dirname(p)
    pool = files + [x + "/" for x in dirs]
    scored = []
    for f in pool:
        fl = f.lower()
        if not q:
            score = len(f)
        else:
            base = os.path.basename(fl.rstrip("/"))
            if base.startswith(q):
                score = len(f)
            elif q in base:
                score = 1000 + len(f)
            elif q in fl:
                score = 2000 + len(f)
            else:
                it = iter(fl)
                if all(ch in it for ch in q):
                    score = 5000 + len(f)
                else:
                    continue
        scored.append((score, f))
    scored.sort()
    return {"files": [f for _, f in scored[:40]]}


def op_write_export(req):
    path = os.path.join(os.path.expanduser(req["cwd"]), os.path.basename(req["name"]))
    with open(path, "a" if req.get("append") else "w", encoding="utf-8") as fh:
        fh.write(req["text"])
    return {"path": path}


POS_RE = re.compile(r"^(.+?)(?::(\d+)(?::\d+)?)?$")
CWD_RE = re.compile(r'"cwd":"(/[^"]+)"|\bcd (~?/[\w.@~+/-]+)')
PATH_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.@~+-/")


def resolve_from_transcript(transcript, rel):
    # Claude writes paths relative to the project it works in, not the chat cwd.
    rel = os.path.normpath(rel).lstrip("./")
    try:
        with open(transcript, "rb") as fh:
            fh.seek(max(0, os.path.getsize(transcript) - 30000000))
            data = fh.read().decode("utf-8", "replace")
    except (OSError, TypeError):
        return None
    hits = []
    needle = "/" + rel
    i = data.find(needle)
    while i >= 0:
        j = i
        while j > 0 and data[j - 1] in PATH_CHARS:
            j -= 1
        if data[j:i].startswith("/"):
            hits.append((i, data[j:i]))
        i = data.find(needle, i + 1)
    hits += [(m.start(), os.path.expanduser(m.group(1) or m.group(2))) for m in CWD_RE.finditer(data)]
    seen = set()
    for _, base in sorted(hits, reverse=True):
        if base in seen:
            continue
        seen.add(base)
        cand = os.path.join(base, rel)
        if os.path.isfile(cand):
            return cand
        # Claude often names a class without its extension (`common/Foo` for common/Foo.java).
        files = [f for f in glob.glob(glob.escape(cand) + ".*") if os.path.isfile(f)]
        if len(files) == 1:
            return files[0]
    return None


def open_local(path, line, app):
    if app == "finder":
        cands = [["open", "-R", path]]
    elif app == "idea":
        cands = [["open", "-a", n, path] for n in ("IntelliJ IDEA", "IntelliJ IDEA Ultimate", "IntelliJ IDEA CE")]
        if shutil.which("idea"):
            cands.insert(0, ["idea"] + (["--line", line] if line else []) + [path])
    elif app == "zed":
        cands = [["open", "-a", "Zed", path]]
        if shutil.which("zed"):
            cands.insert(0, ["zed", path + (":" + line if line else "")])
    else:
        raise SystemExit("unknown app: " + app)
    err = ""
    for argv in cands:
        p = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
        try:
            err = p.communicate(timeout=10)[1].decode("utf-8", "replace").strip()
        except subprocess.TimeoutExpired:
            return
        if p.returncode == 0:
            return
    raise SystemExit(err or "open failed")


def bridge_request(bridge, kind, path, line, app):
    root = os.path.normpath(bridge["root"])
    rid = "%s-%d-%d" % (kind, int(time.time() * 1000), os.getpid())
    req_dir = os.path.join(bridge["dir"], "req")
    os.makedirs(req_dir, exist_ok=True)
    tmp = os.path.join(bridge["dir"], "." + rid + ".tmp")
    with open(tmp, "w") as fh:
        json.dump({"id": rid, "path": path or root, "line": int(line) if line else None, "app": app, "root": root, "ts": time.time()}, fh)
    req_path = os.path.join(req_dir, rid + ".json")
    os.rename(tmp, req_path)
    res = os.path.join(bridge["dir"], "res", rid + ".json")
    for _ in range(50):
        try:
            with open(res) as fh:
                r = json.load(fh)
        except (OSError, ValueError):
            time.sleep(0.1)
            continue
        os.unlink(res)
        if not r.get("ok"):
            raise SystemExit(r.get("error") or kind + " failed")
        return r
    try:
        os.unlink(req_path)
    except OSError:
        pass
    raise SystemExit("open-file bridge not responding — is the host LaunchAgent installed?")


def open_via_bridge(path, line, app, bridge):
    root = os.path.normpath(bridge["root"])
    if path != root and not path.startswith(root.rstrip("/") + "/"):
        raise SystemExit("only files under " + root + " can be opened on the Mac")
    bridge_request(bridge, "open", path, line, app)


def resolve_from_ancestors(cwd, rel):
    d = os.path.dirname(os.path.normpath(cwd)) if cwd else None
    while d and d != os.path.dirname(d):
        if os.path.exists(os.path.join(d, rel)):
            return os.path.join(d, rel)
        d = os.path.dirname(d)
    return None


SKIP_SEGMENTS = ("/build/", "/out/", "/target/", "/node_modules/", "/dist/")


def resolve_elided(path):
    # Claude shortens long paths as `src/.../deep/Foo.java`.
    if "/.../" not in path:
        return None
    pattern = glob.escape(path).replace("/.../", "/**/")
    hits = []
    for f in glob.iglob(pattern, recursive=True):
        if os.path.isfile(f) and not any(seg in f for seg in SKIP_SEGMENTS):
            hits.append(f)
            if len(hits) > 1:
                return None
    return hits[0] if hits else None


def op_open_file(req):
    target = req["path"].strip()
    if target.startswith("file://"):
        target = target[len("file://"):]
    m = POS_RE.match(target)
    path, line = os.path.expanduser(m.group(1)), m.group(2)
    if not os.path.isabs(path):
        rel = path
        path = os.path.join(req.get("cwd") or HOME, rel)
        if not os.path.exists(path):
            path = resolve_from_transcript(req.get("file"), rel) or resolve_from_ancestors(req.get("cwd"), rel) or path
    path = os.path.normpath(path)
    if not os.path.exists(path):
        path = resolve_elided(path) or path
    if not os.path.exists(path):
        raise SystemExit("file not found: " + path)
    app = req.get("app") or "zed"
    bridge = load_config().get("openBridge")
    if sys.platform == "darwin":
        open_local(path, line, app)
    elif isinstance(bridge, dict) and bridge.get("dir") and bridge.get("root"):
        open_via_bridge(path, line, app, bridge)
    else:
        raise SystemExit("Opening files needs the open-file bridge (see docs/INSTALL.md). Use Copy path instead.")
    return {"ok": True, "path": path}


URL_RE = re.compile(r"^https?://[^\s\x00-\x1f\x7f]+$", re.I)


def op_open_url(req):
    url = str(req.get("url") or "").strip()
    if not URL_RE.match(url):
        raise SystemExit("only http(s) links can be opened")
    if sys.platform == "darwin":
        subprocess.run(["open", url], check=True, timeout=15)
        return {"ok": True}
    bridge = load_config().get("openBridge")
    if not (isinstance(bridge, dict) and bridge.get("dir") and bridge.get("root")):
        raise SystemExit("Opening links on the Mac needs the open-file bridge (see docs/INSTALL.md)")
    bridge_request(bridge, "url", url, None, "url")
    return {"ok": True}


FONTS_JS = """ObjC.import("AppKit");
function run() {
  var names = ObjC.deepUnwrap($.NSFontManager.sharedFontManager.availableFontFamilies).filter(function (n) { return n.charAt(0) !== "."; });
  names.sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
  return JSON.stringify({ok: true, fonts: names});
}"""


# Font families installed on the Mac: directly when the server is the Mac, else through the open-file bridge.
def op_fonts(req):
    if sys.platform == "darwin":
        r = subprocess.run(["osascript", "-l", "JavaScript", "-e", FONTS_JS], capture_output=True, text=True, timeout=15)
        if r.returncode != 0:
            raise SystemExit((r.stderr or "could not list fonts").strip())
        return {"fonts": json.loads(r.stdout)["fonts"]}
    bridge = load_config().get("openBridge")
    if not (isinstance(bridge, dict) and bridge.get("dir") and bridge.get("root")):
        return {"fonts": []}
    return {"fonts": bridge_request(bridge, "fonts", None, None, "fonts").get("fonts") or []}


def op_resolve_dir(req):
    p = os.path.expanduser(str(req.get("path") or "").strip())
    p = os.path.abspath(os.path.join(req.get("cwd") or HOME, p))
    return {"path": p, "isDir": os.path.isdir(p)}
