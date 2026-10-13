# Embedded by extension/build.py as CC.CLI_SRC: `python3 -c <this>` with one JSON request on stdin.
import json, os, sys


def package_dir(req):
    home = os.path.expanduser("~")
    for cand in (req.get("serverDir"), os.environ.get("CLAUDE_CHAT_HOME"), os.path.join(home, ".local", "share", "claude-chat", "claude_chat")):
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
    d = package_dir(req)
    if d is None:
        print(json.dumps({"error": "claude-chat server not installed: run server/setup.py --server (or set CLAUDE_CHAT_HOME)"}))
        sys.exit(1)
    sys.path.insert(0, os.path.dirname(d))
    from claude_chat import cli
    cli.main(req)


main()
