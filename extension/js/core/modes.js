window.CC = window.CC || {};

// Chat ⇄ terminal mode of one chat tab (V2-PROPOSAL §4.3). DOM-free: everything goes through `ports`
// (muxy tabs/panes/dialog, agent, mirror, storage), so dev/modes.test.cjs can run the transitions with fakes.
//   chat ──toTerminal──▶ terminal (mirror)   : stop daemon, open a terminal tab running `claude --resume <id>; exit`
//   terminal ──toChat──▶ chat                : tuiExit (if running), daemon start --resume <newest id>
//   adopt(pane) ─────────▶ terminal (mirror)   : Ctrl+Opt+C on a running TUI (bind, else tuiFind by cwd)
CC.Modes = (function () {
  function quote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
  }

  function relDir(project, cwd) {
    if (!project || !cwd || cwd === project) {
      return null;
    }
    return cwd.indexOf(project + "/") === 0 ? cwd.slice(project.length + 1) : null;
  }

  function Modes(ports) {
    this.p = ports;
    this.state = { mode: "chat", terminalTabId: null, paneId: null, pid: null, cliSessionId: null, cwd: null, tuiSeen: false, tuiGone: false };
    this.settings = { defaultMode: "chat", autoReturn: true };
    this.switching = null;
  }

  Modes.prototype.key = function () {
    return "mode:" + this.p.viewId();
  };

  Modes.prototype.notify = function () {
    this.p.onChange(this.state, this.switching);
  };

  Modes.prototype.persist = function () {
    const s = this.state;
    return this.p.storageSet(this.key(), s.mode === "terminal"
      ? { mode: "terminal", terminalTabId: s.terminalTabId, paneId: s.paneId, pid: s.pid, cliSessionId: s.cliSessionId, cwd: s.cwd }
      : null);
  };

  Modes.prototype.loadSettings = async function () {
    const mode = await this.p.storageGet("settings:defaultMode");
    const auto = await this.p.storageGet("settings:autoReturn");
    this.settings.defaultMode = mode === "terminal" ? "terminal" : "chat";
    this.settings.autoReturn = auto !== false;
    return this.settings;
  };

  Modes.prototype.saveSettings = async function (patch) {
    Object.assign(this.settings, patch || {});
    await this.p.storageSet("settings:defaultMode", this.settings.defaultMode);
    await this.p.storageSet("settings:autoReturn", this.settings.autoReturn);
  };

  // A tab reopened in terminal mode goes straight back to the mirror; the TUI may or may not still run.
  Modes.prototype.restore = async function () {
    const stored = await this.p.storageGet(this.key());
    if (stored == null || stored.mode !== "terminal") {
      return false;
    }
    this.enterMirror({ terminalTabId: stored.terminalTabId || null, paneId: stored.paneId || null, pid: stored.pid || null,
      cliSessionId: stored.cliSessionId || null, cwd: stored.cwd || this.p.cwd(), tuiSeen: stored.pid != null });
    return true;
  };

  Modes.prototype.enterMirror = function (fields) {
    this.state = Object.assign({ mode: "terminal", tuiSeen: false, tuiGone: false }, fields);
    this.persist();
    this.p.mirrorStart({ cwd: this.state.cwd, cliSessionId: this.state.cliSessionId, pid: this.state.pid });
    this.notify();
  };

  Modes.prototype.newPane = async function (before) {
    const until = Date.now() + Modes.PANE_WAIT_MS;
    while (Date.now() < until) {
      const panes = await this.p.listPanes();
      const fresh = panes.find(function (x) {
        return before.indexOf(x.id) < 0;
      });
      if (fresh != null) {
        return fresh.id;
      }
      await this.p.sleep(300);
    }
    return null;
  };

  Modes.prototype.toTerminal = async function () {
    if (this.switching != null || this.state.mode === "terminal") {
      return false;
    }
    const st = this.p.status();
    if (st === "busy" || st === "waiting") {
      const choice = await this.p.confirm({ title: "Interrupt Claude and switch to the terminal?",
        message: "The current turn is interrupted; the conversation continues in a terminal tab.", buttons: ["Switch", "Cancel"], default: "Cancel", cancel: "Cancel" });
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
      const command = "cd " + quote(cwd) + " && claude " + (tp.exists ? "--resume " : "--session-id ") + cliSessionId + "; exit";
      const before = (await this.p.listPanes()).map(function (x) {
        return x.id;
      });
      const req = { kind: "terminal", command: command };
      const dir = relDir(await this.p.projectPath(), cwd);
      if (dir != null) {
        req.directory = dir;
      }
      const tabId = await this.p.openTerminal(req);
      const paneId = await this.newPane(before);
      if (tabId != null) {
        await this.p.switchTab(tabId).catch(function (e) {
          console.warn("switch to terminal tab failed", e && e.message);
        });
      }
      this.enterMirror({ terminalTabId: tabId != null ? String(tabId) : null, paneId: paneId, pid: null, cliSessionId: cliSessionId, cwd: cwd });
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
      if (this.settings.autoReturn) {
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
      const choice = await this.p.confirm({ title: "Close Claude in the terminal and continue here?",
        message: "The terminal session ends and the conversation is resumed in this chat.", buttons: ["Continue here", "Cancel"], default: "Continue here", cancel: "Cancel" });
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
      await this.p.agentStart({ sessionId: sessionId, cliSessionId: cliSessionId, resume: tp.exists, cwd: s.cwd });
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
    let tui = null;
    if (pane != null) {
      try {
        const bound = await this.p.reader("bind", { cwd: cwd, screen: await this.p.readScreen(pane.id, 60) });
        if (bound.sid != null) {
          tui = (await this.p.reader("poll", { sid: bound.sid, tail: 1 })).session || null;
        }
      } catch (e) {
        console.warn("bind failed, matching by directory", e && e.message);
      }
    }
    if (tui == null) {
      tui = await this.p.cli("tuiFind", { cwd: cwd });
    }
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

  Modes.PANE_WAIT_MS = 3000;
  Modes.relDir = relDir;
  Modes.quote = quote;
  return Modes;
})();
