"""Git for Review and the chat: diffs, file text, branch, the files a turn touched."""
import json, os, re, subprocess, time

from .transcript import prompt_text

EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
DIFF_CAP = 2000000
UNTRACKED_MAX = 200
UNTRACKED_BYTES = 512000
BRANCHES_BUDGET_S = 20


# A worktree `{repo}-{id}` that was removed after its changes moved to the main checkout: use `{repo}`.
def live_cwd(cwd):
    p = (cwd or ".").rstrip("/") or "/"
    while not os.path.isdir(p) and re.search(r"-[^/-]+$", p):
        p = re.sub(r"-[^/-]+$", "", p)
    return p if os.path.isdir(p) else cwd


def git(cwd, args, timeout=20):
    return subprocess.run(["git", "-c", "core.quotePath=false"] + args, cwd=live_cwd(cwd), capture_output=True, text=True, errors="replace", timeout=timeout)


def diff_path(s):
    s = s.split("\t")[0]
    if s == "/dev/null":
        return None
    return s[2:] if s[:2] in ("a/", "b/") else s


def parse_diff(text, files, budget):
    f = None
    h = None
    for line in text.split("\n"):
        if line.startswith("diff --git "):
            m = re.match(r"diff --git a/(.*) b/(.*)$", line)
            f = {"path": m.group(2) if m else line[11:], "old": None, "status": "modified", "binary": False, "add": 0, "del": 0, "hunks": [], "truncated": False}
            files.append(f)
            h = None
        elif f is None:
            continue
        elif h is None and line.startswith("--- "):
            f["old"] = diff_path(line[4:])
        elif h is None and line.startswith("+++ "):
            p = diff_path(line[4:])
            if p is not None:
                f["path"] = p
            else:
                f["status"] = "deleted"
        elif h is None and line.startswith("new file mode"):
            f["status"] = "added"
        elif h is None and line.startswith("deleted file mode"):
            f["status"] = "deleted"
        elif h is None and line.startswith("rename from "):
            f["old"] = line[12:]
            f["status"] = "renamed"
        elif h is None and line.startswith("rename to "):
            f["path"] = line[10:]
        elif h is None and line.startswith("Binary files "):
            f["binary"] = True
        elif line.startswith("@@"):
            m = re.match(r"@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)", line)
            h = None
            if m and budget[0] > 0:
                h = {"o": int(m.group(1)), "n": int(m.group(2)), "head": m.group(3), "lines": []}
                f["hunks"].append(h)
            elif m:
                f["truncated"] = True
        elif h is not None and line[:1] in ("+", "-", " "):
            h["lines"].append(line)
            budget[0] -= len(line) + 16
            if line[0] == "+":
                f["add"] += 1
            elif line[0] == "-":
                f["del"] += 1
    return files


FILE_TEXT_CAP = 3000000
REV_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9._/~^@{}:+-]*(\.\.\.?[A-Za-z0-9_][A-Za-z0-9._/~^@{}:+-]*)?")


# Claude's own edits between one prompt and the next, as diff files (the hunks of each Edit / Write in order).
def turn_files(path, uuid, budget):
    files, by_path, inside = [], {}, False
    with open(path, "rb") as fh:
        for line in fh:
            if not inside and uuid.encode() not in line:
                continue
            if inside and b'"structuredPatch"' not in line and b'"type":"user"' not in line:
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if not inside:
                inside = e.get("uuid") == uuid
                continue
            if prompt_text(e) is not None:
                break
            r = e.get("toolUseResult")
            if not isinstance(r, dict) or not r.get("filePath") or "structuredPatch" not in r or e.get("isSidechain"):
                continue
            p = r["filePath"]
            f = by_path.get(p)
            if f is None:
                f = {"path": p, "old": None, "status": "added" if r.get("type") == "create" else "modified", "binary": False, "add": 0, "del": 0, "hunks": [], "truncated": False}
                by_path[p] = f
                files.append(f)
            patch = r.get("structuredPatch") or []
            if r.get("type") == "create" and not patch and isinstance(r.get("content"), str):
                lines = r["content"].split("\n")
                patch = [{"oldStart": 0, "newStart": 1, "lines": ["+" + l for l in lines]}]
            for h in patch:
                if budget[0] <= 0:
                    f["truncated"] = True
                    break
                lines = [l for l in (h.get("lines") or []) if l[:1] in ("+", "-", " ")]
                f["hunks"].append({"o": h.get("oldStart") or 0, "n": h.get("newStart") or 0, "head": "", "lines": lines})
                for l in lines:
                    budget[0] -= len(l) + 16
                    f["add"] += l[0] == "+"
                    f["del"] += l[0] == "-"
    return files


# Review "expand context": the whole file on the diff's new side (working tree, or `rev:path`).
def op_file_text(req):
    cwd = req.get("cwd") or "."
    t = git(cwd, ["rev-parse", "--show-toplevel"])
    root = t.stdout.strip() if t.returncode == 0 else cwd
    path, rev = req["path"], req.get("rev")
    if rev:
        if not REV_RE.fullmatch(rev) or path.startswith("-"):
            raise SystemExit("not a revision: " + rev)
        t = git(root, ["show", rev + ":" + path])
        if t.returncode != 0:
            raise SystemExit((t.stderr or "git show failed").strip())
        text = t.stdout
    else:
        with open(path if os.path.isabs(path) else os.path.join(root, path), errors="replace") as fh:
            text = fh.read(FILE_TEXT_CAP)
    lines = text[:FILE_TEXT_CAP].split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return {"lines": lines}


def op_branch(req):
    try:
        r = git(req.get("cwd") or ".", ["symbolic-ref", "--short", "-q", "HEAD"], timeout=5)
        return {"gitBranch": r.stdout.strip() or None}
    except Exception:
        return {"gitBranch": None}


# The lines an untracked file adds in `git diff --no-index`: none for a binary one, as git decides it.
def untracked_lines(path):
    with open(path, "rb") as fh:
        data = fh.read(UNTRACKED_BYTES + 1)
    if b"\0" in data[:8000]:
        return 0
    return data.count(b"\n") + (1 if data and not data.endswith(b"\n") else 0)


# What the rail says about a checkout: branch, linked worktree or not, and op_diff's uncommitted totals without its hunks.
def op_git_status(req):
    out = {"gitBranch": None, "worktree": False, "files": 0, "add": 0, "del": 0}
    cwd = req.get("cwd") or "."
    try:
        r = git(cwd, ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"])
        if r.returncode != 0:
            return out
        root, git_dir, common = r.stdout.splitlines()
        out["worktree"] = os.path.realpath(git_dir) != os.path.realpath(os.path.join(live_cwd(cwd), common))
        out["gitBranch"] = git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"], timeout=5).stdout.strip() or None
        base = "HEAD" if git(root, ["rev-parse", "--verify", "-q", "HEAD"]).returncode == 0 else EMPTY_TREE
        r = git(root, ["diff", "--numstat", "--no-ext-diff", "-M", base])
        for l in r.stdout.splitlines() if r.returncode == 0 else []:
            p = l.split("\t")
            out["files"] += 1
            out["add"] += int(p[0]) if p[0].isdigit() else 0
            out["del"] += int(p[1]) if p[1].isdigit() else 0
        r = git(root, ["ls-files", "-o", "--exclude-standard", "-z"])
        for p in [p for p in r.stdout.split("\0") if p][:UNTRACKED_MAX] if r.returncode == 0 else []:
            full = os.path.join(root, p)
            out["files"] += 1
            if os.path.isfile(full) and os.path.getsize(full) <= UNTRACKED_BYTES:
                out["add"] += untracked_lines(full)
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return out


# One process for all of a server's folders. Past the budget the rest are left out, for the next round: one folder that hangs costs its 5 s, and the
# others' answers still arrive before the page's timeout.
def op_branches(req):
    out = {}
    until = time.monotonic() + BRANCHES_BUDGET_S
    for cwd in req.get("cwds") or []:
        if time.monotonic() >= until:
            break
        out[cwd] = op_branch({"cwd": cwd})["gitBranch"]
    return {"branches": out}


# Files a turn may have written outside Write / Edit (Bash): uncommitted per `git status` and modified between `since`
# and `until` (ms); a guess, the user or another process may have touched them too.
def op_turn_files(req):
    cwd = req.get("cwd") or "."
    try:
        top = git(cwd, ["rev-parse", "--show-toplevel"], timeout=5)
        st = git(cwd, ["status", "--porcelain=v1", "-z", "-uall"], timeout=10)
    except Exception:
        return {"git": False, "files": []}
    if top.returncode != 0 or st.returncode != 0:
        return {"git": False, "files": []}
    root = top.stdout.strip()
    since = float(req.get("since") or 0) / 1000.0 - 2
    until = float(req.get("until") or time.time() * 1000) / 1000.0 + 2
    skip = set(os.path.normpath(p) for p in req.get("exclude") or [])
    out = []
    parts = st.stdout.split("\0")
    i = 0
    while i < len(parts) and len(out) < 200:
        entry = parts[i]
        i += 1
        if len(entry) < 4:
            continue
        code = entry[:2]
        if "R" in code or "C" in code:
            i += 1
        path = os.path.join(root, entry[3:])
        if path in skip or "D" in code:
            continue
        try:
            m = os.stat(path).st_mtime
        except OSError:
            continue
        if since <= m <= until and os.path.isfile(path):
            out.append({"path": path, "status": "new" if code == "??" or "A" in code else "modified", "mtime": int(m * 1000)})
    out.sort(key=lambda f: -f["mtime"])
    return {"git": True, "files": out}


def op_review_sources(req):
    out = {"turns": [], "commits": []}
    path = req.get("file")
    if path and os.path.exists(path):
        turns = []
        with open(path, "rb") as fh:
            for line in fh:
                if b'"type":"user"' not in line:
                    continue
                if b'"structuredPatch"' in line and turns:
                    turns[-1]["edits"] += 1
                    continue
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                t = prompt_text(e)
                if t is not None:
                    turns.append({"uuid": e.get("uuid"), "ts": e.get("timestamp"), "text": t, "edits": 0})
        out["turns"] = [t for t in turns if t["edits"] > 0][-20:][::-1]
    try:
        out["root"] = git(req.get("cwd") or ".", ["rev-parse", "--show-toplevel"]).stdout.strip() or None
        r = git(req.get("cwd") or ".", ["log", "-n", "30", "--format=%H%x09%h%x09%ct%x09%s"])
        for l in r.stdout.splitlines() if r.returncode == 0 else []:
            p = l.split("\t", 3)
            if len(p) == 4:
                out["commits"].append({"sha": p[0], "short": p[1], "ts": int(p[2]) * 1000, "subject": p[3][:160]})
        out["base"] = base_branch(req.get("cwd") or ".")
        out["worktrees"] = worktrees(req.get("cwd") or ".")
    except Exception:
        pass
    return out


# All checkouts of the repo (main first), so Review can diff any worktree from any chat.
def worktrees(cwd):
    r = git(cwd, ["worktree", "list", "--porcelain"], timeout=5)
    out, cur = [], None
    for l in r.stdout.splitlines() if r.returncode == 0 else []:
        if l.startswith("worktree "):
            cur = {"path": l[9:], "branch": None}
            out.append(cur)
        elif cur is not None and l.startswith("branch "):
            cur["branch"] = re.sub(r"^refs/heads/", "", l[7:])
    return [w for w in out if os.path.isdir(w["path"])]


# The branch this one was forked from: the first of master/main (local, then origin) that is not the current branch.
def base_branch(cwd):
    head = git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"], timeout=5).stdout.strip()
    for ref in ("master", "main", "origin/master", "origin/main"):
        if ref == head or git(cwd, ["rev-parse", "--verify", "-q", ref + "^{commit}"], timeout=5).returncode != 0:
            continue
        return ref
    return None


def op_diff(req):
    cwd = req.get("cwd") or "."
    if req.get("turn"):
        budget = [DIFF_CAP]
        files = turn_files(req["file"], req["turn"], budget)
        root = git(cwd, ["rev-parse", "--show-toplevel"]).stdout.strip() or cwd
        for f in files:
            for r in (root, cwd.rstrip("/")):
                if f["path"].startswith(r + "/"):
                    f["path"] = f["path"][len(r) + 1:]
                    break
        return {"root": root, "files": files, "truncated": budget[0] <= 0}
    try:
        r = git(cwd, ["rev-parse", "--show-toplevel"])
    except Exception as e:
        return {"error": "git failed: %s" % e}
    if r.returncode != 0:
        return {"error": "Not a git repository: " + cwd}
    root = r.stdout.strip()
    files = []
    budget = [DIFF_CAP]
    rev = req.get("commit") or req.get("range")
    if rev:
        if not REV_RE.fullmatch(rev):
            return {"error": "Not a commit or range: " + rev}
        args = [rev] if req.get("range") else [rev + "^!"]
        r = git(root, ["diff", "--no-color", "--no-ext-diff", "-M"] + args)
        if r.returncode != 0 and req.get("commit"):
            r = git(root, ["diff", "--no-color", "--no-ext-diff", "-M", EMPTY_TREE, rev])
        if r.returncode != 0:
            return {"error": (r.stderr or "git diff failed").strip()}
        parse_diff(r.stdout, files, budget)
        return {"root": root, "files": files, "truncated": budget[0] <= 0}
    base = "HEAD" if git(root, ["rev-parse", "--verify", "-q", "HEAD"]).returncode == 0 else EMPTY_TREE
    if req.get("base"):
        if not REV_RE.fullmatch(req["base"]):
            return {"error": "Not a branch: " + req["base"]}
        r = git(root, ["merge-base", req["base"], "HEAD"])
        if r.returncode != 0:
            return {"error": (r.stderr or "No common ancestor with " + req["base"]).strip()}
        base = r.stdout.strip()
    r = git(root, ["diff", "--no-color", "--no-ext-diff", "-M", base])
    if r.returncode != 0:
        return {"error": (r.stderr or "git diff failed").strip()}
    parse_diff(r.stdout, files, budget)
    r = git(root, ["ls-files", "-o", "--exclude-standard", "-z"])
    untracked = [p for p in r.stdout.split("\0") if p] if r.returncode == 0 else []
    for p in untracked[:UNTRACKED_MAX]:
        full = os.path.join(root, p)
        if not os.path.isfile(full) or os.path.getsize(full) > UNTRACKED_BYTES or budget[0] <= 0:
            files.append({"path": p, "old": None, "status": "untracked", "binary": False, "add": 0, "del": 0, "hunks": [], "truncated": True})
            continue
        n = len(files)
        parse_diff(git(root, ["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", p]).stdout, files, budget)
        if len(files) == n:
            files.append({"path": p, "old": None, "status": "untracked", "binary": False, "add": 0, "del": 0, "hunks": [], "truncated": False})
        files[-1]["status"] = "untracked"
    return {"root": root, "files": files, "truncated": budget[0] <= 0 or len(untracked) > UNTRACKED_MAX}
