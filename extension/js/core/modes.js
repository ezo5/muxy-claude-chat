// Chat ⇄ terminal mode of one chat. DOM-free: everything goes through `ports` (terminal, dialog, agent, mirror, storage), so
// dev/tests/A3.modes.test.cjs can run the transitions with fakes.
//   chat ──toTerminal──▶ terminal (mirror)   : stop daemon, open a terminal running `claude --resume <id>; exit`
//   terminal ──toChat──▶ chat                : tuiExit (if running), daemon start --resume <newest id>
//   adopt(pane) ─────────▶ terminal (mirror) : a running TUI, found by the pane's folder
CC.Modes = (function () {
  function quote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
  }

  function shellWord(s) {
    return /^[A-Za-z0-9_@%+=:,./-]+$/.test(String(s)) ? String(s) : quote(s);
  }

  function Modes(ports) {
    this.p = ports;
    this.state = { mode: "chat", terminalTabId: null, paneId: null, pid: null, cliSessionId: null, cwd: null, tuiSeen: false, tuiGone: false };
    this.switching = null;
  }

  Modes.prototype.notify = function () {
    this.p.onChange(this.state, this.switching);
  };

  Modes.prototype.persist = function () {
    const s = this.state;
    if (s.mode !== "terminal") {
      return this.p.storageSet(null);
    }
    const v = { mode: "terminal", terminalTabId: s.terminalTabId, paneId: s.paneId, pid: s.pid, cliSessionId: s.cliSessionId, cwd: s.cwd };
    if (s.hooks != null) {
      v.hooks = s.hooks;
    }
    return this.p.storageSet(v);
  };

  // A chat reopened in terminal mode goes straight back to the mirror; the TUI may or may not still run.
  Modes.prototype.restore = async function () {
    const stored = await this.p.storageGet();
    if (stored == null || stored.mode !== "terminal") {
      return false;
    }
    this.enterMirror({ terminalTabId: stored.terminalTabId || null, paneId: stored.paneId || null, pid: stored.pid || null,
      cliSessionId: stored.cliSessionId || null, cwd: stored.cwd || this.p.cwd(), tuiSeen: stored.pid != null, hooks: stored.hooks || null });
    return true;
  };

  Modes.prototype.enterMirror = function (fields) {
    this.state = Object.assign({ mode: "terminal", tuiSeen: false, tuiGone: false }, fields);
    this.persist();
    const opts = { cwd: this.state.cwd, cliSessionId: this.state.cliSessionId, pid: this.state.pid };
    if (this.state.hooks != null) {
      opts.hooks = this.state.hooks;
    }
    this.p.mirrorStart(opts);
    this.notify();
  };

  // Hooks (server/claude_chat/hooks.py) let the chat answer permission prompts and see the TUI's state; an older
  // agent host without `tuiHooks` just starts the TUI without them.
  Modes.prototype.hooks = async function (key) {
    try {
      const res = await this.p.cli("tuiHooks", { key: key });
      return res != null && res.settings ? res : null;
    } catch (e) {
      console.warn("terminal hooks unavailable", e && e.message);
      return null;
    }
  };

  Modes.prototype.toTerminal = async function () {
    if (this.switching != null || this.state.mode === "terminal") {
      return false;
    }
    const st = this.p.status();
    if (st === "busy" || st === "waiting") {
      const choice = await this.p.confirm("Interrupt Claude and switch to the terminal? The current turn is interrupted; the conversation continues in a terminal.", ["Switch", "Cancel"]);
      if (choice !== "Switch") {
        return false;
      }
    }
    this.switching = "toTerminal";
    this.notify();
    try {
      const cwd = this.p.cwd();
      const cliSessionId = this.p.cliSessionId() || this.p.uuid();
      const tp = await this.p.cli("transcriptPath", { cwd: cwd, cliSessionId: cliSessionId });
      if (this.p.sessionId() != null) {
        await this.p.agentStop();
      }
      const hooks = await this.hooks(this.p.sessionId() || cliSessionId);
      const bin = shellWord(await this.p.claudeBin());
      const command = bin + " " + (hooks != null ? "--settings " + quote(hooks.settings) + " " : "") +
        (tp.exists ? "--resume " : "--session-id ") + cliSessionId + "; exit";
      const opened = await this.p.openTerminal({ cwd: cwd, command: command });
      if (opened.paneId != null) {
        await this.p.focusTerminal(opened.paneId).catch(function (e) {
          console.warn("switch to the terminal failed", e && e.message);
        });
      }
      this.enterMirror({ terminalTabId: opened.tabId != null ? String(opened.tabId) : null, paneId: opened.paneId != null ? String(opened.paneId) : null, pid: null,
        cliSessionId: cliSessionId, cwd: cwd, hooks: hooks != null ? hooks.dir : null });
      return true;
    } finally {
      this.switching = null;
      this.notify();
    }
  };

  // Mirror feedback: the TUI's pid and session id (changes after /clear); gone after it was seen → back to chat.
  Modes.prototype.onTui = function (tui) {
    const s = this.state;
    if (s.mode !== "terminal") {
      return;
    }
    if (tui != null) {
      const changed = tui.pid !== s.pid || (tui.sessionId != null && tui.sessionId !== s.cliSessionId) || !s.tuiSeen || s.tuiGone;
      s.pid = tui.pid;
      s.cliSessionId = tui.sessionId || s.cliSessionId;
      s.tuiSeen = true;
      s.tuiGone = false;
      if (changed) {
        this.persist();
        this.notify();
      }
      return;
    }
    if (s.tuiSeen && !s.tuiGone) {
      s.tuiGone = true;
      this.notify();
      if (this.p.autoReturn()) {
        this.toChat().catch(function (e) {
          console.warn("auto return failed", e && e.message);
        });
      }
    }
  };

  Modes.prototype.toChat = async function () {
    if (this.switching != null || this.state.mode !== "terminal") {
      return false;
    }
    const s = this.state;
    const found = await this.p.cli("tuiFind", { pid: s.pid, cliSessionId: s.cliSessionId });
    if (found != null) {
      const choice = await this.p.confirm("Close Claude in the terminal and continue here? The terminal session ends and the conversation is resumed in this chat.", ["Continue here", "Cancel"]);
      if (choice !== "Continue here") {
        return false;
      }
    }
    this.switching = "toChat";
    this.notify();
    try {
      let cliSessionId = s.cliSessionId;
      if (found != null) {
        const res = await this.p.cli("tuiExit", { pid: found.pid, cliSessionId: s.cliSessionId });
        if (res.exited !== true) {
          throw new Error("the terminal Claude did not exit");
        }
        cliSessionId = res.sessionId || cliSessionId;
      }
      this.p.mirrorStop();
      const tp = await this.p.cli("transcriptPath", { cwd: s.cwd, cliSessionId: cliSessionId });
      const sessionId = this.p.sessionId() || cliSessionId;
      const paneId = s.paneId;
      this.state = { mode: "chat", terminalTabId: null, paneId: null, pid: null, cliSessionId: cliSessionId, cwd: s.cwd, tuiSeen: false, tuiGone: false };
      await this.persist();
      await this.p.agentStart({ sessionId: sessionId, cliSessionId: cliSessionId, resume: tp.exists, cwd: s.cwd, freshEvents: true });
      if (paneId != null) {
        await this.closePaneLater(paneId);
      }
      return true;
    } finally {
      this.switching = null;
      this.notify();
    }
  };

  // `; exit` closes the tab by itself; close the pane only when it is still there.
  Modes.prototype.closePaneLater = async function (paneId) {
    await this.p.sleep(1500);
    const panes = await this.p.listPanes();
    if (panes.some(function (x) {
      return String(x.id) === String(paneId);
    })) {
      await this.p.closePane(paneId);
    }
  };

  Modes.prototype.adopt = async function (data) {
    const panes = await this.p.listPanes();
    const pane = panes.find(function (x) {
      return String(x.id) === String(data.paneId);
    }) || null;
    const cwd = pane != null && pane.workingDirectory ? pane.workingDirectory : this.p.cwd();
    const tui = await this.p.cli("tuiFind", { cwd: cwd });
    if (tui == null) {
      throw new Error("No running Claude found for " + cwd);
    }
    this.enterMirror({ terminalTabId: data.terminalTabId != null ? String(data.terminalTabId) : null, paneId: data.paneId != null ? String(data.paneId) : null,
      pid: tui.pid, cliSessionId: tui.sessionId, cwd: tui.cwd || cwd, tuiSeen: true });
    return tui;
  };

  Modes.prototype.toggle = function () {
    return this.state.mode === "terminal" ? this.toChat() : this.toTerminal();
  };

  Modes.quote = quote;
  return Modes;
})();
