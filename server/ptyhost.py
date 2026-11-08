# The page's terminals. Muxy's exec has no streaming, so this runs twice: a short client per request (one JSON line on stdin, the answer on stdout) and
# one detached host holding the ptys, reached over a socket only this user can open. Stands alone, as it also runs where the server package isn't installed.
# The page sends this file on stdin before the request (host.js, PTY_LOADER), so Muxy's consent dialog shows a short line. The client is what a key press waits for, so it
# imports nearly nothing. Requests: open, read, write, resize, close, list.
import os
import socket
import sys

FOLDER = os.path.join(os.path.expanduser("~"), ".cache", "claude-chat", "pty")
SOCKET = os.path.join(FOLDER, "host-2.sock")
START_WAIT_S = 3.0
IDLE_EXIT_S = 60
MAX_KEPT = 2 * 1024 * 1024
MAX_CHUNK = 128 * 1024
MAX_WAIT_MS = 25000


def ask(request):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.connect(SOCKET)
        s.sendall(request)
        out = bytearray()
        while True:
            part = s.recv(262144)
            if not part:
                return bytes(out)
            out += part
    finally:
        s.close()


def client(request):
    try:
        out = ask(request)
    except OSError:
        # Only opening a terminal starts the host: there's nothing to ask one that isn't running.
        if b'"op":"open"' not in request:
            out = b'{"gone":true}' if b'"op":"list"' not in request else b'{"terminals":[]}'
        else:
            out = start_and_ask(request)
    sys.stdout.buffer.write(out)


def start_and_ask(request):
    import time

    spawn_host()
    until = time.monotonic() + START_WAIT_S
    while True:
        try:
            return ask(request)
        except OSError:
            if time.monotonic() > until:
                raise
            time.sleep(0.02)


# Detached and without our pipes, or the exec running this client wouldn't end.
def spawn_host():
    first = os.fork()
    if first != 0:
        os.waitpid(first, 0)
        return
    try:
        os.setsid()
        if os.fork() != 0:
            os._exit(0)
        null = os.open(os.devnull, os.O_RDWR)
        for fd in (0, 1, 2):
            os.dup2(null, fd)
        host()
    finally:
        os._exit(0)


class Terminal:
    def __init__(self, tid, fd, pid, cwd, project):
        self.id = tid
        self.fd = fd
        self.pid = pid
        self.cwd = cwd
        self.project = project
        self.kept = bytearray()
        self.base = 0  # the stream position of kept[0]
        self.outgoing = bytearray()
        self.waiting = []
        self.exited = False

    def end(self):
        return self.base + len(self.kept)

    def keep(self, data):
        self.kept += data
        over = len(self.kept) - MAX_KEPT
        if over > 0:
            del self.kept[:over]
            self.base += over


def shell_of():
    import pwd

    try:
        return pwd.getpwuid(os.getuid()).pw_shell or os.environ.get("SHELL") or "/bin/sh"
    except KeyError:
        return os.environ.get("SHELL") or "/bin/sh"


def set_size(fd, cols, rows):
    import fcntl
    import struct
    import termios

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", int(rows), int(cols), 0, 0))


# Where the shell is now, which adopting a Claude running in it has to know. Null when that can't be read.
def live_cwd(pid):
    try:
        return os.readlink("/proc/%d/cwd" % pid)
    except OSError:
        pass
    import subprocess

    try:
        out = subprocess.run(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"], capture_output=True, text=True, timeout=3).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    return next((line[1:] for line in out.splitlines() if line.startswith("n")), None)


def start_shell(cwd, cols, rows, command):
    import pty

    shell = shell_of()
    pid, fd = pty.fork()
    if pid != 0:
        os.set_blocking(fd, False)
        set_size(fd, cols, rows)
        return pid, fd
    try:
        import signal

        # Ignored in the host, and an ignored signal stays ignored through exec.
        for name in ("SIGHUP", "SIGPIPE", "SIGXFSZ"):
            signal.signal(getattr(signal, name), signal.SIG_DFL)
        home = os.path.expanduser("~")
        where = cwd if cwd and os.path.isdir(cwd) else home
        os.chdir(where)
        env = dict(os.environ)
        env.update({"TERM": "xterm-256color", "COLORTERM": "truecolor", "PWD": where, "HOME": home, "SHELL": shell})
        # A Mac app's environment has no locale, and a shell without one escapes every non-ASCII letter.
        if not (env.get("LC_ALL") or env.get("LC_CTYPE") or env.get("LANG")):
            env["LANG"] = "en_US.UTF-8"
        login = "-" + os.path.basename(shell)
        # Interactive too, as the PATH that finds a program may come from the shell's rc file.
        os.execve(shell, [login, "-i", "-c", command] if command else [login], env)
    finally:
        os._exit(127)


def host():
    import base64
    import fcntl
    import json
    import selectors
    import signal
    import time

    os.makedirs(FOLDER, mode=0o700, exist_ok=True)
    os.chmod(FOLDER, 0o700)
    # Two opens at once start two hosts: the second stops here, and its client finds the first.
    lock = open(os.path.join(FOLDER, "host.lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return
    try:
        os.unlink(SOCKET)
    except OSError:
        pass
    # A shell that went away shouldn't take the host with it when we write to it, nor Muxy's server when it restarts.
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(SOCKET)
    os.chmod(SOCKET, 0o600)
    listener.listen(64)
    listener.setblocking(False)

    terminals = {}
    # Plain select: on a Mac, kqueue and poll don't work on a pty, which is the default this would otherwise get.
    selector = selectors.SelectSelector()
    selector.register(listener, selectors.EVENT_READ, ("listener", None))
    incoming = {}
    ended_pids = []
    last_used = time.monotonic()

    def finish(conn, answer):
        selector.unregister(conn)
        incoming.pop(conn, None)
        try:
            conn.setblocking(True)
            conn.settimeout(5)
            conn.sendall(json.dumps(answer).encode())
        except OSError:
            pass
        conn.close()

    def read_answer(t, start):
        at = min(max(start, t.base), t.end())
        part = bytes(t.kept[at - t.base:at - t.base + MAX_CHUNK])
        return {"to": at + len(part), "data": base64.b64encode(part).decode(), "exited": t.exited and at + len(part) >= t.end()}

    def wake(t):
        ready = t.waiting
        t.waiting = []
        for w in ready:
            finish(w["conn"], read_answer(t, w["from"]))

    def watch_shell(t):
        selector.modify(t.fd, selectors.EVENT_READ | (selectors.EVENT_WRITE if t.outgoing else 0), ("pty", t))

    def shell_ended(t):
        if t.exited:
            return
        t.exited = True
        selector.unregister(t.fd)
        os.close(t.fd)
        ended_pids.append(t.pid)
        wake(t)

    def drop(t):
        if not t.exited:
            shell_ended(t)
            try:
                os.killpg(t.pid, signal.SIGHUP)
            except OSError:
                pass
        terminals.pop(t.id, None)

    def flush(t):
        try:
            sent = os.write(t.fd, bytes(t.outgoing))
            del t.outgoing[:sent]
        except BlockingIOError:
            pass
        except OSError:
            t.outgoing.clear()
        watch_shell(t)

    def handle(conn, req):
        op = req.get("op")
        if op == "open":
            tid = "term-" + os.urandom(6).hex()
            pid, fd = start_shell(req.get("cwd"), req.get("cols") or 100, req.get("rows") or 30, req.get("command"))
            t = Terminal(tid, fd, pid, req.get("cwd"), req.get("project"))
            terminals[tid] = t
            selector.register(fd, selectors.EVENT_READ, ("pty", t))
            return finish(conn, {"id": tid})
        if op == "list":
            # A shell that ended with no pane to notice is simply gone.
            for t in [t for t in terminals.values() if t.exited and not t.waiting]:
                drop(t)
            return finish(conn, {"terminals": [{"id": t.id, "cwd": live_cwd(t.pid) or t.cwd, "project": t.project} for t in terminals.values()]})
        t = terminals.get(req.get("id"))
        if t is None:
            return finish(conn, {"gone": True})
        if op == "read":
            start = min(int(req.get("from") or 0), t.end())
            if t.exited or t.end() > start:
                return finish(conn, read_answer(t, start))
            until = time.monotonic() + min(int(req.get("waitMs") or 0), MAX_WAIT_MS) / 1000.0
            return t.waiting.append({"conn": conn, "from": start, "until": until})
        if not t.exited:
            if op == "write":
                t.outgoing += base64.b64decode(req.get("data") or "")
                flush(t)
            elif op == "resize":
                set_size(t.fd, req.get("cols") or 100, req.get("rows") or 30)
        if op == "close":
            drop(t)
        return finish(conn, {"ok": True})

    def from_client(conn):
        try:
            part = conn.recv(1048576)
        except OSError:
            part = b""
        if not part:
            # The client went away, also the one a read was waiting for.
            for t in terminals.values():
                t.waiting = [w for w in t.waiting if w["conn"] is not conn]
            selector.unregister(conn)
            incoming.pop(conn, None)
            conn.close()
            return
        incoming[conn] += part
        if b"\n" in incoming[conn]:
            # Stays registered: end of input while a read waits says its client is gone.
            line = bytes(incoming[conn]).split(b"\n", 1)[0]
            incoming[conn] = bytearray()
            try:
                handle(conn, json.loads(line.decode()))
            except Exception as e:
                finish(conn, {"error": str(e)})

    def from_shell(t):
        try:
            data = os.read(t.fd, 65536)
        except BlockingIOError:
            return
        except OSError:
            data = b""
        if not data:
            shell_ended(t)
            return
        t.keep(data)
        wake(t)

    def tick(now):
        for pid in list(ended_pids):
            try:
                if os.waitpid(pid, os.WNOHANG)[0] != 0:
                    ended_pids.remove(pid)
            except OSError:
                ended_pids.remove(pid)
        for t in list(terminals.values()):
            for w in [w for w in t.waiting if w["until"] <= now]:
                t.waiting.remove(w)
                finish(w["conn"], read_answer(t, w["from"]))
            if t.exited:
                continue
            # Its pty stays open while a background job holds it, and then no end of file says the shell is gone.
            try:
                gone = os.waitpid(t.pid, os.WNOHANG)[0] != 0
            except OSError:
                gone = True
            if gone:
                before = -1
                while not t.exited and t.end() != before:
                    before = t.end()
                    from_shell(t)
                shell_ended(t)

    while True:
        now = time.monotonic()
        if terminals or incoming:
            last_used = now
        elif now - last_used > IDLE_EXIT_S:
            break
        for key, events in selector.select(0.25):
            kind, target = key.data
            if kind == "listener":
                try:
                    conn, _ = listener.accept()
                except OSError:
                    continue
                conn.setblocking(False)
                incoming[conn] = bytearray()
                selector.register(conn, selectors.EVENT_READ, ("client", conn))
            elif kind == "client":
                if target in incoming:
                    from_client(target)
            elif kind == "pty" and target.id in terminals and not target.exited:
                if events & selectors.EVENT_WRITE and target.outgoing:
                    flush(target)
                if events & selectors.EVENT_READ:
                    from_shell(target)
        tick(time.monotonic())
    try:
        os.unlink(SOCKET)
    except OSError:
        pass


if __name__ == "__main__":
    client(sys.stdin.buffer.read())
