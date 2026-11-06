"""Muxy's own CLI on this server: which projects are here, and adding one. From the page's one bootstrap, so no consent prompt of its own.
A server without the CLI answers `available: false`, and the page falls back."""
import json, os, shutil, subprocess

import config

LIST_TIMEOUT_S = 8
ADD_TIMEOUT_S = 15


def cli_path():
    path = os.pathsep.join([os.path.join(config.HOME, ".local", "bin"), os.environ.get("PATH") or os.defpath])
    return shutil.which("muxy", path=path)


def run(argv, timeout):
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError) as e:
        raise SystemExit("muxy project failed: %s" % e)


# Null ids: the catalog can't be read, which the page treats like no CLI.
def op_list(req):
    muxy = cli_path()
    if muxy is None:
        return {"available": False, "ids": None}
    try:
        res = run([muxy, "project", "list", "--json"], LIST_TIMEOUT_S)
        rows = json.loads(res.stdout) if res.returncode == 0 else None
    except (SystemExit, ValueError):
        rows = None
    ids = [str(r["id"]) for r in rows if isinstance(r, dict) and "id" in r] if isinstance(rows, list) else None
    return {"available": True, "ids": ids}


def op_add(req):
    path = req.get("path")
    if not isinstance(path, str) or not path:
        raise SystemExit("muxyProjectAdd needs path")
    muxy = cli_path()
    if muxy is None:
        return {"available": False}
    argv = [muxy, "project", "add", os.path.expanduser(path), "--json"]
    if req.get("name"):
        argv += ["--name", str(req["name"])]
    if req.get("createIfMissing") is True:
        argv.append("--create")
    res = run(argv, ADD_TIMEOUT_S)
    if res.returncode != 0:
        raise SystemExit((res.stderr or "").strip() or "muxy project add failed")
    return {"available": True}


OPS = {"muxyProjects": op_list, "muxyProjectAdd": op_add}
