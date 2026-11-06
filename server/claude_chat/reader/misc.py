"""Commands and prompt history, usage stats, typography, error log, changelog, doctor."""
import glob, json, os, re, shutil, sys, time

from .common import CLAUDE, CONFIG, HOME, STATE, load_config

def frontmatter(path):
    desc, hint = "", ""
    try:
        with open(path, errors="replace") as fh:
            head = fh.read(4000)
    except Exception:
        return desc, hint
    if head.startswith("---"):
        end = head.find("\n---", 3)
        block = head[3:end] if end > 0 else ""
        for line in block.splitlines():
            m = re.match(r"\s*(description|argument-hint)\s*:\s*(.*)", line)
            if m:
                v = m.group(2).strip().strip("\"'")
                if m.group(1) == "description":
                    desc = v
                else:
                    hint = v
        body = head[end + 4:] if end > 0 else head
    else:
        body = head
    if not desc:
        for line in body.splitlines():
            line = line.strip().lstrip("#").strip()
            if line:
                desc = line
                break
    return desc[:200], hint[:80]


def scan_commands(root, prefix, source, out):
    cdir = os.path.join(root, "commands")
    for f in glob.glob(os.path.join(cdir, "**", "*.md"), recursive=True):
        rel = os.path.relpath(f, cdir)[:-3].replace(os.sep, ":")
        desc, hint = frontmatter(f)
        out.append({"name": prefix + rel, "desc": desc, "hint": hint, "source": source})
    for f in glob.glob(os.path.join(root, "skills", "*", "SKILL.md")):
        name = os.path.basename(os.path.dirname(f))
        desc, hint = frontmatter(f)
        out.append({"name": prefix + name, "desc": desc, "hint": hint, "source": source + " skill"})


def op_meta(req):
    cwd = req.get("cwd") or ""
    cmds = []
    scan_commands(CLAUDE, "", "user", cmds)
    if cwd:
        scan_commands(os.path.join(cwd, ".claude"), "", "project", cmds)
    try:
        with open(os.path.join(CLAUDE, "plugins", "installed_plugins.json")) as fh:
            plugins = json.load(fh).get("plugins", {})
        for key, installs in plugins.items():
            pname = key.split("@")[0]
            for inst in installs:
                if inst.get("scope") == "project" and inst.get("projectPath") != cwd:
                    continue
                p = inst.get("installPath")
                if p and os.path.isdir(p):
                    scan_commands(p, pname + ":", "plugin", cmds)
                    break
    except Exception:
        pass
    seen, uniq = set(), []
    for c in cmds:
        if c["name"] not in seen:
            seen.add(c["name"])
            uniq.append(c)
    return {"commands": uniq, "history": op_history(cwd)}


def op_history(cwd, limit=300):
    path = os.path.join(CLAUDE, "history.jsonl")
    out, seen = [], set()
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            fh.seek(max(0, size - 3000000))
            lines = fh.read().splitlines()
    except Exception:
        return out
    for line in reversed(lines):
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("project") != cwd:
            continue
        text = e.get("display") or ""
        pasted = e.get("pastedContents") or {}
        for k, v in pasted.items():
            if isinstance(v, dict) and v.get("type") == "text" and v.get("content"):
                text = re.sub(r"\[Pasted text #" + re.escape(str(k)) + r"[^\]]*\]", lambda m: v["content"], text)
        if text and text not in seen:
            seen.add(text)
            out.append(text)
            if len(out) >= limit:
                break
    return out


DEFAULT_USAGE_DIR = os.path.join(HOME, ".claude-usage")


def op_stats(req):
    out = {"status": None, "usage": None, "history": []}
    sid = str(req.get("sessionId") or "")
    if re.fullmatch(r"[0-9a-f-]{36}", sid):
        try:
            with open(os.path.join(STATE, "statusline", sid + ".json")) as fh:
                out["status"] = json.load(fh)
        except (OSError, ValueError):
            pass
    usage_dir = os.path.expanduser(load_config().get("usageDir") or DEFAULT_USAGE_DIR)
    try:
        with open(os.path.join(usage_dir, "usage.json")) as fh:
            out["usage"] = json.load(fh)
    except (OSError, ValueError):
        pass
    hist = os.path.join(STATE, "usage-history.jsonl")
    if not os.path.exists(hist):
        hist = os.path.join(usage_dir, "history.jsonl")
    cutoff = time.time() - 86400
    try:
        with open(hist, "rb") as fh:
            fh.seek(max(0, os.path.getsize(hist) - 60000))
            for line in fh.read().splitlines():
                try:
                    h = json.loads(line)
                except ValueError:
                    continue
                if h.get("ts", 0) >= cutoff:
                    out["history"].append(h)
    except OSError:
        pass
    return out


def op_save_typography(req):
    path = os.path.join(os.path.dirname(CONFIG), "typography.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump({"settings": req.get("settings") or {}, "vars": req.get("vars") or {}}, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, path)
    return {"ok": True, "path": path}


ERROR_LOG = os.path.join(STATE, "errors.log")


def op_log_error(req):
    os.makedirs(os.path.dirname(ERROR_LOG), exist_ok=True)
    with open(ERROR_LOG, "a") as fh:
        fh.write(str(req.get("text") or "").replace("\n", " ") + "\n")
    return {"ok": True}


CHANGELOG = os.path.join(CLAUDE, "cache", "changelog.md")


# The CLI keeps the Claude Code changelog here (fetched in the background by the interactive CLI), newest first.
def op_changelog(req):
    try:
        with open(CHANGELOG, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        return {"path": CHANGELOG, "versions": [], "total": 0, "missing": True}
    parts = re.split(r"^## +", text, flags=re.M)[1:]
    skip = int(req.get("skip") or 0)
    limit = int(req.get("limit") or 10)
    versions = []
    for p in parts[skip:skip + limit]:
        head, _, body = p.partition("\n")
        versions.append({"version": head.strip(), "text": body.strip()})
    return {"path": CHANGELOG, "versions": versions, "total": len(parts), "mtime": int(os.path.getmtime(CHANGELOG) * 1000)}


def install_type(path):
    real = os.path.realpath(path)
    if "/node_modules/" in real:
        return "npm-global"
    if real.startswith(os.path.join(HOME, ".local", "share", "claude")) or real.startswith(os.path.join(HOME, ".claude", "local")):
        return "native"
    if real.startswith("/opt/homebrew") or "/Cellar/" in real or "/linuxbrew/" in real:
        return "homebrew"
    return "other"


def settings_check(path):
    if not os.path.isfile(path):
        return {"path": path, "exists": False}
    try:
        with open(path) as fh:
            json.load(fh)
        return {"path": path, "exists": True, "ok": True}
    except (OSError, ValueError) as e:
        return {"path": path, "exists": True, "ok": False, "error": str(e)}


# /doctor: which claude binary the daemon would start (same order as server config.claude_bin), other installs on
# PATH, and whether the settings files parse.
def op_doctor(req):
    cwd = req.get("cwd") or HOME
    try:
        with open(CONFIG) as fh:
            configured = (json.load(fh) or {}).get("claudeBin")
    except (OSError, ValueError):
        configured = None
    chosen = None
    for cand in [configured, shutil.which("claude"), os.path.join(HOME, ".local", "bin", "claude")]:
        if cand and os.path.isfile(cand) and os.access(cand, os.X_OK):
            chosen = cand
            break
    seen = set()
    installs = []
    for d in (os.environ.get("PATH") or "").split(os.pathsep) + [os.path.join(HOME, ".local", "bin")]:
        p = os.path.join(d, "claude")
        if d and os.path.isfile(p) and os.access(p, os.X_OK) and os.path.realpath(p) not in seen:
            seen.add(os.path.realpath(p))
            installs.append({"path": p, "real": os.path.realpath(p), "type": install_type(p)})
    files = [os.path.join(CLAUDE, "settings.json"), os.path.join(CLAUDE, "settings.local.json"), os.path.join(cwd, ".claude", "settings.json"),
             os.path.join(cwd, ".claude", "settings.local.json"), os.path.join(HOME, ".claude.json"),
             "/Library/Application Support/ClaudeCode/managed-settings.json" if sys.platform == "darwin" else "/etc/claude-code/managed-settings.json"]
    return {"binary": chosen, "real": os.path.realpath(chosen) if chosen else None, "type": install_type(chosen) if chosen else None,
            "configured": configured, "installs": installs, "settings": [settings_check(f) for f in files],
            "changelog": os.path.isfile(CHANGELOG)}
