"""The reader ops, behind the same API as the daemon ops: `cli.py` registers `OPS`.

In-process callers use `poll` and `changed`. `poll` raises SystemExit on a request it can't serve, like every op here."""
import os

from . import agents, files, follow, git, images, misc, perf, sessions, transcript


# Requests may name transcripts as ~/.claude/projects/…; every op taking `file` gets the real path.
def expand_paths(req):
    for key in ("file", "agentFile"):
        if isinstance(req.get(key), str) and req[key].startswith("~/"):
            req[key] = os.path.expanduser(req[key])
    return req


def poll(req):
    return follow.op_poll(expand_paths(req))


changed = follow.changed


# Any failure reaches the caller as {"error"}, which cli.main prints for a SystemExit.
def api(fn):
    def run(req):
        try:
            return fn(expand_paths(req))
        except Exception as e:
            raise SystemExit("%s: %s" % (type(e).__name__, e))
    return run


# `wait` is left to cli.py: the daemon has an op of that name too.
wait = api(follow.op_wait)
OPS = {name: api(fn) for name, fn in {
    "poll": follow.op_poll, "hookRespond": follow.op_hook_respond, "older": transcript.op_older, "agents": agents.op_agents,
    "sessions": sessions.op_sessions, "searchSessions": sessions.op_search_sessions,
    "diff": git.op_diff, "reviewSources": git.op_review_sources, "fileText": git.op_file_text, "branch": git.op_branch, "branches": git.op_branches, "gitStatus": git.op_git_status, "turnFiles": git.op_turn_files,
    "files": files.op_files, "openFile": files.op_open_file, "openUrl": files.op_open_url, "fonts": files.op_fonts,
    "writeExport": files.op_write_export, "resolveDir": files.op_resolve_dir,
    "image": images.op_image, "writeImage": images.op_write_image,
    "meta": misc.op_meta, "stats": misc.op_stats, "saveTypography": misc.op_save_typography, "logError": misc.op_log_error,
    "changelog": misc.op_changelog, "doctor": misc.op_doctor, "perf": perf.op_perf,
}.items()}
