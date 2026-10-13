window.CC = window.CC || {};

// Composition: store + agent (daemon driver) or mirror (terminal mode) + transcript + composer plugins + sidebars.
// Tab data: {cwd, sessionId?, newSession?, projectId?, directory?, model?, permissionMode?, file?(dev),
//            paneId?, paneTitle?, terminalTabId? (adopt a terminal), mode?: "terminal" (dev: mirror sessionId),
//            agentFile?, agentTitle?, daemon? (read-only subagent transcript, the parent's daemon session id)}.
(function () {
  const util = CC.util;
  const el = util.el;
  const data = muxy.data || {};
  const cwd = data.cwd || data.directory || "";
  const agentView = data.agentFile != null;
  const LABELS = { idle: "Ready", busy: "Working…", waiting: "Needs input", stopped: "Stopped", starting: "Starting…", connecting: "Connecting…", error: "Error", offline: "Not running" };
  const NEW_CHAT_KEYS = [["⏎", "send"], ["⇧ ⏎", "new line"], ["/", "commands"], ["@", "mention a file"], ["↑", "previous prompt"], ["⌘ F", "find"], ["⌃ `", "chat ⇄ terminal"]];
  const TAB_DOTS = { busy: "accent", waiting: "warn", idle: "success", error: "danger", stopped: "danger", offline: "danger" };
  const $ = function (id) {
    return document.getElementById(id);
  };
  const titleEl = $("title");
  const subEl = $("subtitle");
  const statusEl = $("status");
  const startBtn = $("start-btn");
  const modelBtn = $("model-btn");
  const viewSeg = $("view-seg");
  const chatBtn = $("chat-btn");
  const termBtn = $("terminal-btn");
  const footer = $("footer");
  let lastTitle = null;
  let lastTabIcon = null;
  let announced = null;
  let tabFocused = muxy.focused === true;
  let mirror = null;
  let branchAt = 0;
  let renaming = false;
  const previews = {};

  [["new-btn", "plus"], ["stop-btn", "power"], ["jump", "down"], ["pins-btn", "sidebar"], ["settings-btn", "gear"]].forEach(function (b) {
    $(b[0]).appendChild(util.icon(b[1]));
  });

  const agentsBtn = toolbarButton("agents", "Agents");
  const reviewBtn = toolbarButton("diff", "Review changes");

  function toolbarButton(iconName, title) {
    const b = el("button", "tb-btn");
    b.type = "button";
    b.title = title;
    b.appendChild(util.icon(iconName));
    return b;
  }

  const store = new CC.Store();
  // Tab data is fixed at open, so a new chat's daemon session is kept per tab to resume it after a muxy restart.
  const SESSION_KEY = "session:" + CC.host.viewId();
  const agent = new CC.Agent(store, { cwd: cwd, file: data.file || null, onSession: function (sid) {
    CC.host.storageSet(SESSION_KEY, sid);
  } });
  CC.store = store;
  CC.agent = agent;

  const pins = new CC.Pins($("pins"), $("pins-btn"), {
    refreshMarks: function () {
      transcript.refreshPins();
    },
    jump: function (id) {
      return transcript.jumpTo(id);
    },
  });

  const agents = new CC.Agents($("agents"), agentsBtn, {
    store: store,
    cwd: function () {
      return store.meta.cwd || cwd;
    },
    daemon: function () {
      return agentView ? data.daemon || null : agent.sessionId || null;
    },
    onRunning: function () {
      paintStatus();
    },
  });

  const review = new CC.Review($("review"), reviewBtn, {
    store: store,
    cwd: function () {
      return store.meta.cwd || cwd;
    },
    file: function () {
      return transcriptFile();
    },
    send: function (text) {
      composer.dispatch({ id: util.uid(), text: text, images: [], createdAt: Date.now() }, false);
    },
  });

  const rewind = new CC.Rewind({
    store: store,
    status: function () {
      return mirror != null ? "terminal" : store.status;
    },
    control: function (subtype, payload) {
      return agent.control(subtype, payload);
    },
    composer: function () {
      return composer;
    },
    file: function () {
      return agent.currentFile();
    },
  });

  CC.rewind = rewind;

  const transcript = new CC.Transcript($("scroller"), {
    store: store,
    pins: pins,
    rewind: agentView ? null : rewind,
    followUp: function (text) {
      const flat = text.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
      const cut = flat.length > 160 ? flat.slice(0, 160).replace(/\s\S*$/, "") + "…" : flat;
      composer.setValue("> " + cut + "\n\n" + composer.value().trim());
      composer.focus();
    },
    loadOlder: function () {
      return mirror != null ? mirror.loadOlder() : agent.loadOlder();
    },
    jump: $("jump"),
    openTurn: function (user, tools) {
      review.openTurn(user, tools);
    },
    previewsFor: function (item) {
      return item.clientId != null ? previews[item.clientId] || null : null;
    },
  });
  CC.transcript = transcript;
  transcript.cwd = cwd;
  transcript.setEmptyText("Starting Claude…");

  // Footer overlays the scroller, so composer growth only changes padding, never the scroll viewport.
  new ResizeObserver(function () {
    const stick = transcript.atBottom();
    document.documentElement.style.setProperty("--footer-h", footer.offsetHeight + "px");
    if (stick) {
      transcript.scrollToBottom(false);
    }
  }).observe(footer);

  function transcriptFile() {
    return mirror != null ? mirror.file : agent.currentFile();
  }

  // Prompt history and the static command list come from the V1 reader once per tab.
  async function loadMeta() {
    try {
      const m = await CC.host.reader("meta", { cwd: store.meta.cwd || cwd });
      composer.commands = m.commands || [];
      composer.setHistory(m.history || []);
    } catch (e) {
      console.warn("meta failed", e && e.message);
    }
  }

  async function refreshBranch() {
    const dir = store.meta.cwd || cwd;
    if (!dir || mirror != null) {
      return;
    }
    branchAt = Date.now();
    try {
      const res = await CC.host.reader("branch", { cwd: dir });
      if (res.gitBranch !== store.meta.gitBranch) {
        store.setMeta({ gitBranch: res.gitBranch || null });
      }
    } catch (e) {
      console.warn("branch failed", e && e.message);
    }
  }

  function send(entry) {
    const pending = { id: entry.id, text: entry.text, images: (entry.images || []).length, previews: entry.previews || [] };
    previews[entry.id] = entry.previews || [];
    transcript.addPending(pending);
    composer.markSent();
    return agent.send(entry.text, entry.images || [], entry.id).catch(function (e) {
      const msg = e && e.message ? e.message : String(e);
      if (entry.queued === true) {
        transcript.removePending(pending);
      } else {
        transcript.setPendingNote(pending, "Not sent: " + msg + " — click to edit", true);
        pending.row.addEventListener("click", function () {
          transcript.removePending(pending);
          composer.setValue(entry.text);
          composer.restoreImages(entry.images, entry.previews);
          composer.focus();
        }, { once: true });
      }
      throw e;
    });
  }

  const composer = new CC.Composer(footer, {
    store: store,
    send: send,
    interrupt: function () {
      agent.interrupt().catch(function (e) {
        util.toast("Interrupt failed: " + e.message, "error");
      });
    },
    respond: function (requestId, behavior, extra) {
      return agent.respond(requestId, behavior, extra);
    },
    control: function (subtype, payload) {
      return agent.control(subtype, payload);
    },
    stop: function () {
      return agent.stop();
    },
    restart: function (opts) {
      return agent.restart(opts);
    },
    files: async function (q) {
      const res = await CC.host.reader("files", { cwd: store.meta.cwd || cwd || ".", q: q });
      return res.files || [];
    },
    sessions: function () {
      return CC.host.reader("sessions", { cwd: store.meta.cwd || cwd, current: store.meta.cliSessionId || agent.sessionId });
    },
    sessionId: function () {
      return store.meta.cliSessionId || agent.sessionId;
    },
  });

  const wipeBtn = composer.button("trash", "Clear chat (keeps the conversation context)", function () {
    transcript.wipe();
  });
  composer.left.append(reviewBtn, agentsBtn, wipeBtn);

  // The footer is hidden in a subagent tab: agents go to the header, next to a way back to the chat that opened it.
  if (agentView) {
    agentsBtn.className = "hdr-btn";
    document.querySelector(".hdr-actions").prepend(agentsBtn);
    const backBtn = el("button", "hdr-btn");
    backBtn.type = "button";
    backBtn.title = "Back to " + (data.parentTitle || "the parent chat");
    backBtn.appendChild(util.icon("chevronLeft"));
    backBtn.addEventListener("click", function () {
      if (data.parentTab == null) {
        util.toast("Parent chat unknown — this tab was opened by an older version");
        return;
      }
      muxy.tabs.switchTo(data.parentTab).catch(function () {
        util.toast("The parent chat is closed");
      });
    });
    $("topbar").prepend(backBtn);
  }

  // --- modes (chat ⇄ terminal), see core/modes.js ---

  const modes = new CC.Modes({
    viewId: function () {
      return CC.host.viewId();
    },
    storageGet: CC.host.storageGet,
    storageSet: CC.host.storageSet,
    cwd: function () {
      return store.meta.cwd || cwd;
    },
    projectPath: async function () {
      try {
        const project = (await muxy.projects.list()).find(function (p) {
          return p.isActive;
        });
        return project != null ? project.path : null;
      } catch (e) {
        return null;
      }
    },
    status: function () {
      return store.status;
    },
    sessionId: function () {
      return agent.sessionId;
    },
    cliSessionId: function () {
      return store.meta.cliSessionId || null;
    },
    uuid: util.uuid,
    sleep: util.sleep,
    confirm: function (d) {
      return muxy.dialog.confirm(d);
    },
    cli: CC.host.cli,
    reader: CC.host.reader,
    agentStop: async function () {
      const sid = agent.sessionId;
      if (store.status === "busy" || store.status === "waiting") {
        await agent.interrupt().catch(function () {});
      }
      await agent.stop();
      await agent.waitStopped(sid);
      agent.stopLoop();
    },
    agentStart: function (opts) {
      return agent.start(opts);
    },
    listPanes: function () {
      return muxy.panes.list();
    },
    openTerminal: function (req) {
      return muxy.tabs.open(req);
    },
    switchTab: function (id) {
      return muxy.tabs.switchTo(id);
    },
    closePane: function (id) {
      return muxy.panes.close(id);
    },
    readScreen: function (paneId, lines) {
      return muxy.panes.readScreen(paneId, lines);
    },
    mirrorStart: function (opts) {
      if (mirror != null) {
        mirror.end();
      }
      mirror = new CC.Mirror(store, { cwd: opts.cwd, cliSessionId: opts.cliSessionId, pid: opts.pid, file: data.file || null, onTui: function (tui) {
        modes.onTui(tui);
      } });
      transcript.setEmptyText("Terminal mode", "The conversation shows here as it happens in the terminal tab.");
      mirror.begin();
    },
    mirrorStop: function () {
      if (mirror != null) {
        mirror.end();
        mirror = null;
      }
    },
    onChange: function () {
      syncState();
    },
  });
  CC.modes = modes;
  new CC.Settings($("settings-btn"), modes, [{ label: "Export as Markdown", run: exportMarkdown }]);

  function switchMode(fn) {
    return fn().catch(function (e) {
      util.toast("Mode switch failed: " + (e && e.message ? e.message : String(e)), "error");
    });
  }

  chatBtn.addEventListener("click", function () {
    if (modes.state.mode === "terminal") {
      switchMode(function () {
        return modes.toChat();
      });
    }
  });
  termBtn.addEventListener("click", function () {
    if (modes.state.mode !== "terminal") {
      switchMode(function () {
        return modes.toTerminal();
      });
    } else if (modes.state.terminalTabId != null) {
      muxy.tabs.switchTo(modes.state.terminalTabId).catch(function (e) {
        util.toast("Terminal tab not found: " + e.message, "error");
      });
    }
  });
  document.addEventListener("keydown", function (e) {
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "`") {
      e.preventDefault();
      switchMode(function () {
        return modes.toggle();
      });
    }
  });

  function paintMode() {
    const terminal = modes.state.mode === "terminal";
    const switching = modes.switching != null;
    document.body.dataset.mode = modes.state.mode;
    viewSeg.classList.toggle("hidden", agentView);
    $("settings-btn").classList.toggle("hidden", agentView);
    chatBtn.classList.toggle("active", !terminal);
    termBtn.classList.toggle("active", terminal);
    chatBtn.disabled = switching;
    termBtn.disabled = switching;
    chatBtn.classList.toggle("attn", modes.state.tuiGone);
    chatBtn.title = !terminal ? "Chat" : modes.state.tuiGone ? "Claude exited in the terminal — continue here" : "Close the terminal Claude and continue here (Ctrl+`)";
    termBtn.title = terminal ? "Show the terminal tab" : "Continue in a terminal tab (Ctrl+`)";
  }

  // --- header / status ---

  function modelName(meta) {
    const id = meta.modelId || meta.model || "";
    const m = (meta.models || []).find(function (x) {
      return x.value === meta.model || x.resolvedModel === id || (x.value && id.indexOf(x.value) >= 0);
    });
    return m != null ? m.displayName : meta.model || (meta.modelId ? prettyModel(meta.modelId) : null);
  }

  function prettyModel(id) {
    const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
    return m != null ? m[1].charAt(0).toUpperCase() + m[1].slice(1) + " " + m[2] + (m[3] ? "." + m[3] : "") : id;
  }

  function title(max) {
    const meta = store.meta;
    const named = (agentView ? data.agentTitle : null) || meta.title || meta.customTitle || meta.topic || meta.aiTitle;
    if (named) {
      return util.firstLine(named, max || 60);
    }
    const first = store.items.find(function (it) {
      return it.k === "user" && !it.command && it.text;
    });
    return first != null ? util.firstLine(first.text, max || 60) : (cwd.replace(/\/+$/, "").split("/").pop() || "Claude");
  }

  function paintStatus() {
    const st = store.status;
    const terminal = modes.state.mode === "terminal";
    const running = agents.running > 0 && st === "idle";
    statusEl.className = "status st-" + (running ? "busy" : st);
    statusEl.textContent = "";
    statusEl.appendChild(el("span", "dot"));
    let label = LABELS[st] || st;
    if (st === "busy" && !terminal && store.meta.turn != null && store.meta.turn.startedAt) {
      label = (store.meta.activity === "compacting" ? "Compacting… " : "Working… ") + util.fmtDuration(Date.now() - store.meta.turn.startedAt);
    }
    if (terminal && st === "offline" && !modes.state.tuiSeen) {
      label = "Starting in terminal…";
    }
    statusEl.appendChild(el("span", "status-label", label));
    if (agents.running > 0) {
      statusEl.appendChild(el("span", "status-agents", "· " + agents.running + (agents.running === 1 ? " agent" : " agents")));
    }
    statusEl.title = store.statusDetail || "";
    document.body.dataset.status = st;
    startBtn.classList.toggle("hidden", terminal || agentView || st !== "stopped");
    $("stop-btn").classList.toggle("hidden", terminal || agentView || st === "stopped" || st === "connecting");
    transcript.setWorking(st === "busy", label);
    const icon = CC.theme.dotIcon(TAB_DOTS[running ? "busy" : st] || "muted");
    if (icon !== lastTabIcon) {
      lastTabIcon = icon;
      muxy.tabs.setIcon({ svg: icon }).catch(function () {});
    }
  }

  function paintHeader() {
    const meta = store.meta;
    const name = title();
    if (!renaming) {
      titleEl.textContent = name;
    }
    subEl.textContent = "";
    const dir = (meta.cwd || cwd).replace(/\/+$/, "").split("/").pop();
    const full = [meta.cwd || cwd];
    if (dir) {
      subEl.appendChild(el("span", "sub-dir", dir));
    }
    if (meta.gitBranch) {
      subEl.appendChild(el("span", "sub-sep", "·"));
      subEl.appendChild(util.branchChip(meta.gitBranch, "sub-branch"));
      full.push("Branch: " + meta.gitBranch);
    }
    if (modes.state.mode === "terminal") {
      subEl.appendChild(el("span", "sub-sep", "·"));
      subEl.appendChild(el("span", "sub-mode", "terminal"));
    }
    if (agentView) {
      subEl.appendChild(el("span", "sub-sep", "·"));
      subEl.appendChild(el("span", "sub-mode", "subagent"));
    }
    subEl.title = full.join("\n");
    const model = modelName(meta);
    const readOnly = modes.state.mode === "terminal" || agentView;
    modelBtn.classList.toggle("hidden", model == null);
    modelBtn.disabled = readOnly;
    modelBtn.title = readOnly ? "Model (from the transcript)" : "Model and effort (click to switch)";
    modelBtn.textContent = model != null ? model + (meta.effort ? " · " + meta.effort : "") : "";
    if (name !== lastTitle) {
      lastTitle = name;
      muxy.tabs.setTitle(name).catch(function () {});
    }
  }

  // Tells the background script which session this tab shows, so it can notify when the tab is not focused.
  function announce() {
    if (muxy.events == null) {
      return;
    }
    const msg = { tab: CC.host.viewId(), sid: agent.sessionId, title: lastTitle, pane: null, focused: tabFocused, mode: modes.state.mode };
    const sig = JSON.stringify(msg);
    if (sig === announced) {
      return;
    }
    announced = sig;
    muxy.events.emit("extension.chat", msg).catch(function () {
      announced = null;
    });
  }

  function syncState() {
    const meta = store.meta;
    const terminal = modes.state.mode === "terminal";
    composer.setMeta(Object.assign({}, meta, { model: modelName(meta) }));
    composer.setStatus(terminal ? "terminal" : store.status, store.statusDetail);
    composer.setPending(terminal ? [] : store.pending);
    const file = transcriptFile();
    if (file !== transcript.file) {
      transcript.file = file;
      agents.setFile(file);
    }
    if (meta.cwd) {
      transcript.cwd = meta.cwd;
    }
    pins.load(agentView ? data.agentFile : agent.sessionId || meta.cliSessionId || null);
    paintMode();
    paintStatus();
    paintHeader();
    announce();
  }

  store.on("state", syncState);
  store.on("reset", function () {
    if (agentView) {
      transcript.setEmptyText("Subagent", "The subagent's transcript shows here.");
    } else if (modes.state.mode === "terminal") {
      transcript.setEmptyText("Terminal mode", "The conversation shows here as it happens in the terminal tab.");
    } else {
      transcript.setEmptyText(null, null, NEW_CHAT_KEYS);
    }
  });
  store.on("items:add", function (items) {
    if (items.some(function (it) {
      return it.k === "user";
    })) {
      paintHeader();
    }
    if (mirror == null && items.some(function (it) {
      return it.k === "turn";
    })) {
      agent.control("get_context_usage", { detail: "summary" }).catch(function () {});
      refreshBranch();
    }
  });
  store.on("state", function () {
    if (mirror == null && store.meta.cwd && Date.now() - branchAt > 60000) {
      refreshBranch();
    }
  });
  setInterval(paintStatus, 1000);
  CC.theme.onChange(function () {
    lastTabIcon = null;
    paintStatus();
  });

  // The webview blocks downloads (navigation outside muxy-ext://), so the file goes next to the project on the server.
  async function exportMarkdown() {
    const dir = store.meta.cwd || cwd;
    try {
      for (let i = 0; store.hasOlder && i < 200; i++) {
        await transcript.requestOlder();
        if (transcript.loadingOlder) {
          await util.sleep(150);
        }
      }
      const text = CC.exportMarkdown(store, { title: title(), cwd: dir });
      const d = new Date();
      const pad = function (n) {
        return String(n).padStart(2, "0");
      };
      const name = "claude-chat-export-" + d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + ".md";
      let res = null;
      for (let i = 0; i < text.length; i += 200000) {
        res = await CC.host.reader("writeExport", { cwd: dir, name: name, text: text.slice(i, i + 200000), append: i > 0 });
      }
      util.toast("Exported to " + res.path);
    } catch (e) {
      util.toast("Export failed: " + (e && e.message ? e.message : String(e)), "error");
    }
  }

  CC.openPath = function (target, app) {
    return CC.host.reader("openFile", { path: target, app: app, cwd: store.meta.cwd || cwd, file: transcriptFile() });
  };

  // rename_session with source "host" is the SDK's user rename: it works mid-turn and adds no chat bubble.
  titleEl.addEventListener("dblclick", function () {
    if (renaming || agentView || modes.state.mode === "terminal") {
      return;
    }
    const before = title(200);
    const input = el("input", "title-edit");
    input.value = before;
    input.spellcheck = false;
    renaming = true;
    titleEl.textContent = "";
    titleEl.appendChild(input);
    input.focus();
    input.select();
    function done(save) {
      if (!renaming) {
        return;
      }
      renaming = false;
      const name = input.value.replace(/\s+/g, " ").trim();
      if (save && name !== "" && name !== before) {
        if (store.status === "stopped") {
          util.toast("Start Claude to rename this chat", "error");
        } else {
          store.setMeta({ title: name });
          agent.control("rename_session", { title: name, source: "host" }).catch(function (e) {
            util.toast("Rename failed: " + e.message, "error");
          });
        }
      }
      paintHeader();
      composer.focus();
    }
    input.addEventListener("keydown", function (e) {
      if (e.isComposing) {
        return;
      }
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        done(e.key === "Enter");
      }
    });
    input.addEventListener("blur", function () {
      done(false);
    });
  });

  modelBtn.addEventListener("click", function () {
    composer.openModelPicker();
  });

  startBtn.addEventListener("click", function () {
    agent.start({ resume: true }).catch(function (e) {
      util.toast("Start failed: " + e.message, "error");
    });
  });

  $("stop-btn").addEventListener("click", async function () {
    const choice = await muxy.dialog.confirm({
      title: "Stop Claude in this chat?",
      message: "The conversation stays and can be resumed with Start.",
      buttons: ["Stop", "Cancel"],
      default: "Cancel",
      cancel: "Cancel",
    });
    if (choice === "Stop") {
      agent.stop().catch(function (e) {
        util.toast("Stop failed: " + e.message, "error");
      });
    }
  });

  $("new-btn").addEventListener("click", async function () {
    try {
      const projects = await muxy.projects.list();
      const project = projects.find(function (p) {
        return p.isActive;
      }) || null;
      const dir = project != null ? project.path : cwd;
      await muxy.tabs.open({
        kind: "extensionWebView",
        extension: { id: "claude-chat", tabType: "chat", data: { newSession: true, cwd: dir, projectId: project != null ? project.id : null, directory: dir } },
      });
    } catch (e) {
      util.toast("New chat failed: " + e.message, "error");
    }
  });

  if (muxy.events != null) {
    muxy.events.subscribe("extension.activity", function (e) {
      if (mirror == null && agent.sessionId != null && e.sid != null && String(e.sid) === String(agent.sessionId)) {
        agent.kick(0);
      }
    });
  }
  if (typeof muxy.onFocus === "function") {
    muxy.onFocus(function (focused) {
      tabFocused = focused === true;
      if (focused) {
        composer.focus();
        if (mirror != null) {
          mirror.kick(0);
        } else {
          agent.kick(0);
        }
      }
      announce();
    });
  }

  // --- boot: restored terminal mode → adopt a terminal → new chat in the default mode → chat on the daemon ---

  async function boot() {
    await CC.typography.load();
    if (agentView) {
      document.body.classList.add("agent-view");
      transcript.setEmptyText("Loading the subagent transcript…");
      mirror = new CC.Mirror(store, { cwd: cwd, agentFile: data.agentFile, daemon: data.daemon || null, onTui: function () {} });
      mirror.begin();
      return;
    }
    loadMeta();
    await modes.loadSettings();
    if (await modes.restore()) {
      return;
    }
    if (data.paneId != null) {
      transcript.setEmptyText("Looking for Claude in the terminal…");
      await modes.adopt(data);
      return;
    }
    if (data.mode === "terminal" && data.sessionId != null) {
      modes.enterMirror({ terminalTabId: data.terminalTabId || null, paneId: data.paneId || null, pid: data.pid || null, cliSessionId: data.sessionId, cwd: cwd, tuiSeen: data.pid != null });
      return;
    }
    const sid = data.sessionId != null ? data.sessionId : await CC.host.storageGet(SESSION_KEY);
    if (sid == null && data.newSession === true && modes.settings.defaultMode === "terminal") {
      await modes.toTerminal();
      return;
    }
    const first = sid != null ? { sessionId: sid, resume: true } : { model: data.model, permissionMode: data.permissionMode };
    await agent.start(first);
  }

  syncState();
  boot().catch(function (e) {
    transcript.setEmptyText("Claude could not start", e && e.message ? e.message : String(e));
  });
  composer.focus();
})();
