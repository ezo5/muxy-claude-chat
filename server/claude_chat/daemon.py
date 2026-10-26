import json, os, queue, signal, subprocess, sys, threading, time, uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import agent_tracker, config, procs, protocol
import state as S

STOP_WAIT_S = 60
STOP_KILL_S = 10
POLL_S = 0.1
STATE_THROTTLE_S = 0.25


def log(*parts):
    sys.stderr.write(time.strftime("%H:%M:%S ") + " ".join(str(p) for p in parts) + "\n")
    sys.stderr.flush()


def log_tail(d, n=2000):
    try:
        with open(os.path.join(d, "daemon.log"), "rb") as fh:
            fh.seek(0, 2)
            fh.seek(max(0, fh.tell() - n))
            return fh.read().decode("utf-8", "replace").strip()
    except OSError:
        return ""


class Daemon:
    def __init__(self, d, args):
        self.d = d
        self.args = args
        self.cfg = config.load()
        self.state = S.read_state(d) or S.new_state(args["sessionId"], args["cwd"])
        rows = self.state.get("agents")
        self.agents = agent_tracker.Tracker(rows if isinstance(rows, list) else None)
        self.seq = S.last_seq(d)
        self.lines = queue.Queue()
        self.proc = None
        self.eof = False
        self.init_done = False
        self.control = {}
        self.chunks = {}
        self.stopping = None
        self.stop_deadline = None
        self.kill_deadline = None
        self.stop_wait = float(self.cfg.get("stopWaitMs") or STOP_WAIT_S * 1000) / 1000.0
        self.stop_kill = float(self.cfg.get("stopKillMs") or STOP_KILL_S * 1000) / 1000.0
        self.last_activity = time.time()
        self.dirty = 0
        self.last_write = 0

    # --- state / events ---
    def mark(self, level=2):
        self.dirty = max(self.dirty, level)

    def apply(self, up):
        if up:
            self.state.update(up)
            self.mark(2)

    def flush(self, force=False):
        if not self.dirty:
            return
        if self.dirty == 1 and not force and time.time() - self.last_write < STATE_THROTTLE_S:
            return
        if self.state["status"] not in ("starting", "stopping", "stopped"):
            self.state["status"] = protocol.status_of(self.state)
        S.write_state(self.d, self.state)
        self.dirty = 0
        self.last_write = time.time()

    def emit(self, ev, level=2):
        self.seq += 1
        S.append_event(self.d, self.seq, ev)
        self.state["lastSeq"] = self.seq
        self.mark(level)

    def daemon_event(self, subtype, **kw):
        ev = {"type": "daemon", "subtype": subtype}
        ev.update(kw)
        self.emit(ev)

    # --- CLI process ---
    def send(self, obj):
        if not self.proc or self.proc.stdin.closed:
            raise BrokenPipeError("cli stdin closed")
        self.proc.stdin.write((json.dumps(obj, ensure_ascii=False) + "\n").encode())
        self.proc.stdin.flush()

    def reader(self):
        try:
            for line in self.proc.stdout:
                self.lines.put(line)
        finally:
            self.lines.put(None)

    def spawn(self):
        claude = config.claude_bin(self.cfg)
        if not claude:
            self.fail("claude binary not found (PATH, ~/.local/bin/claude or config claudeBin)")
            return False
        a = self.args
        argv = protocol.build_argv(claude, a.get("cliSessionId") or a["sessionId"], resume=bool(a.get("resume")), fork=bool(a.get("fork")),
                                   model=a.get("model"), effort=a.get("effort"), permission_mode=a.get("permissionMode"),
                                   partial=a.get("partial", True), extra=self.cfg.get("extraArgs"),
                                   plugin_dirs=a.get("pluginDirs"), add_dirs=a.get("addDirs"), system_prompt_file=a.get("appendSystemPromptFile"))
        log("spawn", json.dumps(argv))
        try:
            # the daemon ignores SIGHUP; the CLI must not inherit that
            self.proc = subprocess.Popen(argv, cwd=a["cwd"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr.fileno(),
                                         env=protocol.cli_env(os.environ), preexec_fn=lambda: signal.signal(signal.SIGHUP, signal.SIG_DFL))
        except OSError as e:
            self.fail("cannot start claude: %s" % e)
            return False
        self.state["cliPid"] = self.proc.pid
        self.state["cliPidStarted"] = procs.start_time(self.proc.pid)
        self.state["cliMarker"] = a.get("cliSessionId") or a["sessionId"]
        threading.Thread(target=self.reader, daemon=True).start()
        self.daemon_event("started", pid=os.getpid(), argv=argv, cliVersion=self.state.get("cliVersion"), resumed=bool(a.get("resume")))
        try:
            self.send(protocol.initialize_request())
        except OSError as e:
            log("initialize write failed:", e)
        return True

    def fail(self, error):
        log("error:", error)
        self.daemon_event("error", error=error)
        self.finish("error", None, error)

    def finish(self, reason, exit_code, error=None):
        self.stopping = self.stopping or reason
        self.poll_inbox()
        ev = {"reason": reason, "exitCode": exit_code}
        if error:
            ev["error"] = error
        self.daemon_event("stopped", **ev)
        S.prune_inbox(self.d, self.state.get("inboxOffset") or 0)
        self.state.update({"status": "stopped", "stoppedAt": S.now_ms(), "reason": reason, "pid": None, "cliPid": None, "pending": [],
                           "promptQueue": [], "promptUuids": {}, "startedUuids": [], "followUp": False, "turn": {"startedAt": None, "promptId": None}, "activity": None, "inboxOffset": 0})
        self.flush(force=True)
        try:
            os.remove(os.path.join(self.d, "daemon.pid"))
        except OSError:
            pass
        log("stopped", reason, exit_code)
        sys.exit(0)

    def begin_stop(self, reason, force=False):
        if self.stopping:
            if force and self.proc is not None and self.proc.poll() is None:
                self.proc.terminate()
            return
        log("stopping:", reason, "force" if force else "")
        self.stopping = reason
        self.stop_deadline = time.time() + (5 if force else self.stop_wait)
        self.state["status"] = "stopping"
        self.mark(2)
        if self.proc is None:
            return
        self.close_stdin()
        if force and self.proc.poll() is None:
            self.proc.terminate()

    def close_stdin(self):
        try:
            self.proc.stdin.close()
        except OSError:
            pass

    # --- CLI stdout ---
    def handle_line(self, line):
        ev = protocol.parse_line(line)
        if ev is None:
            return
        t = ev.get("type")
        self.emit(ev, 1 if t == "stream_event" else 2)
        now = S.now_ms()
        up = protocol.apply_event(self.state, ev, now)
        if self.agents.feed(ev, agent_tracker.iso(now)):
            up["agents"] = self.agents.list()
        if t == "control_response":
            r = ev.get("response") or {}
            rid = r.get("request_id")
            if rid == protocol.INIT_REQUEST_ID:
                self.init_done = True
                if self.state["status"] == "starting":
                    self.state["status"] = "idle"
            req = self.control.pop(rid, None)
            if req is not None:
                target = protocol.rewound_target(req, r)
                if target:
                    self.daemon_event("rewound", id=rid, target=target)
                self.daemon_event("control_result", id=rid, response=r)
                up.update(protocol.apply_control_result(self.state, req, r))
        if t in ("result", "control_request"):
            self.last_activity = time.time()
        self.apply(up)

    # --- inbox ---
    def poll_inbox(self):
        lines, off = S.read_new_lines(os.path.join(self.d, "inbox.jsonl"), self.state.get("inboxOffset") or 0)
        if not lines:
            return
        self.state["inboxOffset"] = off
        self.mark(2)
        for raw in lines:
            try:
                entry = json.loads(raw)
            except ValueError:
                log("inbox: bad line", raw[:200])
                continue
            self.handle_cmd(entry)

    def handle_cmd(self, entry):
        cid = entry.get("id")
        cmd = entry.get("cmd") or {}
        t = cmd.get("type")
        self.last_activity = time.time()
        if self.stopping and t == "stop":
            self.daemon_event("accepted", id=cid, cmd="stop")
            self.begin_stop("stop", force=bool(cmd.get("force")))
            return
        if self.stopping:
            self.daemon_event("rejected", id=cid, error="daemon is stopping")
            return
        try:
            if t == "prompt":
                self.prompt(cid, cmd)
            elif t == "prompt_chunk":
                self.chunk(cid, cmd)
            elif t == "respond":
                self.respond(cid, cmd)
            elif t == "interrupt":
                self.send(protocol.control_request(cid, "interrupt"))
                self.control[cid] = {"subtype": "interrupt"}
                self.daemon_event("accepted", id=cid, cmd="interrupt")
            elif t == "control":
                self.control_cmd(cid, cmd)
            elif t == "stop":
                self.daemon_event("accepted", id=cid, cmd="stop")
                self.begin_stop("stop", force=bool(cmd.get("force")))
            else:
                self.daemon_event("rejected", id=cid, error="unknown command type %r" % t)
        except (BrokenPipeError, OSError, ValueError) as e:
            self.daemon_event("rejected", id=cid, error="cli stdin: %s" % e)

    def prompt(self, cid, cmd):
        text = cmd.get("text") or ""
        m = protocol.MODEL_CMD_RE.match(text)
        if m:
            # a set_model control outlives a later `/model x` local command, so mirror the slash command as a control
            req = protocol.control_request(cid + ":model", "set_model", {"model": m.group(1)})
            self.control[req["request_id"]] = req["request"]
            self.send(req)
        uid = str(uuid.uuid4())
        self.send(protocol.user_message(text, cmd.get("images"), uid))
        self.apply(protocol.apply_prompt(self.state, cid, text, S.now_ms(), uid))
        self.daemon_event("accepted", id=cid, cmd="prompt", text=text, images=len(cmd.get("images") or []), clientId=cmd.get("clientId"), uuid=uid)

    def chunk(self, cid, cmd):
        key = cmd.get("chunkId")
        total = int(cmd.get("total") or 0)
        c = self.chunks.setdefault(key, {})
        c[int(cmd.get("index") or 0)] = cmd.get("data") or ""
        if len(c) < total:
            self.daemon_event("accepted", id=cid, cmd="prompt_chunk")
            return
        del self.chunks[key]
        try:
            full = json.loads("".join(c[i] for i in range(total)))
        except (ValueError, KeyError) as e:
            self.daemon_event("rejected", id=cid, error="bad prompt chunks: %s" % e)
            return
        self.prompt(cid, full)

    def respond(self, cid, cmd):
        rid = cmd.get("requestId")
        pending = self.state.get("pending") or []
        if not any(p["requestId"] == rid for p in pending):
            self.daemon_event("rejected", id=cid, error="unknown requestId %r" % rid)
            return
        self.send(protocol.control_response(rid, protocol.respond_payload(cmd)))
        self.apply({"pending": [p for p in pending if p["requestId"] != rid]})
        self.daemon_event("accepted", id=cid, cmd="respond")

    def control_cmd(self, cid, cmd):
        sub = cmd.get("subtype")
        payload = {k: v for k, v in cmd.items() if k not in ("type", "subtype")}
        self.daemon_event("accepted", id=cid, cmd="control")
        if sub == "supported_commands":
            self.daemon_event("control_result", id=cid, response={"subtype": "success", "request_id": cid, "response": {"commands": self.state.get("commands") or []}})
            return
        sub = protocol.CONTROL_ALIASES.get(sub, sub)
        req = protocol.control_request(cid, sub, payload)
        self.control[cid] = req["request"]
        self.send(req)

    # --- main loop ---
    def run(self):
        os.makedirs(self.d, exist_ok=True)
        with open(os.path.join(self.d, "daemon.pid"), "w") as fh:
            fh.write(str(os.getpid()))
        try:
            self.state["inboxOffset"] = os.path.getsize(os.path.join(self.d, "inbox.jsonl"))
        except OSError:
            self.state["inboxOffset"] = 0
        self.state.update({"pid": os.getpid(), "pidStarted": procs.start_time(os.getpid()), "cliPid": None, "cliPidStarted": None, "cliMarker": None,
                           "status": "starting", "startedAt": S.now_ms(), "stoppedAt": None, "reason": None,
                           "pending": [], "promptQueue": [], "promptUuids": {}, "startedUuids": [], "followUp": False, "turn": {"startedAt": None, "promptId": None}, "activity": None, "cwd": self.args["cwd"],
                           "agents": self.agents.list()})
        for k in ("model", "effort", "permissionMode", "pluginDirs", "addDirs", "appendSystemPromptFile"):
            if self.args.get(k):
                self.state[k] = self.args[k]
        self.mark(2)
        self.flush(force=True)
        signal.signal(signal.SIGTERM, lambda *a: self.begin_stop("stop", force=True))
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        if self.stopping:
            self.finish(self.stopping, None)
        if not self.spawn():
            return
        if self.stopping:
            # SIGTERM landed during the spawn
            self.close_stdin()
            self.proc.terminate()
        idle_s = float(self.cfg.get("idleStopMs") or 0) / 1000.0
        while True:
            try:
                line = self.lines.get(timeout=POLL_S)
                while True:
                    if line is None:
                        self.eof = True
                    else:
                        self.handle_line(line)
                    line = self.lines.get_nowait()
            except queue.Empty:
                pass
            self.poll_inbox()
            code = self.proc.poll()
            if code is not None and (self.eof or self.stopping):
                self.flush(force=True)
                if self.stopping:
                    self.finish(self.stopping, code)
                elif code != 0 or not self.init_done:
                    self.finish("error", code, "claude exited with code %s: %s" % (code, log_tail(self.d)))
                else:
                    self.finish("exit", code)
            if self.stopping and self.kill_deadline is not None and time.time() > self.kill_deadline:
                log("stop timeout, SIGKILL")
                self.proc.kill()
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
                self.finish(self.stopping, -9)
            if self.stopping and self.kill_deadline is None and time.time() > self.stop_deadline:
                log("stop timeout, SIGTERM")
                self.proc.terminate()
                self.kill_deadline = time.time() + self.stop_kill
            if not self.stopping and idle_s > 0 and not self.state.get("pending") and not self.state.get("promptQueue") \
                    and not self.state.get("followUp") \
                    and time.time() - self.last_activity > idle_s:
                self.begin_stop("idle")
            self.flush()


def main():
    d = sys.argv[1]
    args = json.loads(sys.argv[2])
    Daemon(d, args).run()


if __name__ == "__main__":
    main()
