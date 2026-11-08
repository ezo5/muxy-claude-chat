// Sidebar, up to three panes, rail. The page has one shell; everything per chat lives in its pane or its runtime.
CC.Shell = (function () {
  const el = CC.util.el;
  const MAX_PANES = 3;
  const SAVE_DELAY_MS = 200;
  // Width limits of the two sides. Each may take at most this share of the window, and the panes keep MIN_MAIN.
  const WIDTHS = { sidebar: { min: 180, max: 520, cssVar: "--sidebar-width" }, rail: { min: 220, max: 520, cssVar: "--rail-width" } };
  const MAX_SHARE = 0.4;
  const MIN_MAIN = 340;
  // Same as .cc-pane's min-width: below that the panes scroll sideways instead of squeezing one.
  const MIN_PANE = 300;
  const KEY_STEP = 16;
  // splits: a pane row's shares by its shape, so Review comes back at its width after being closed. See shapeOf.
  const S = { panes: [], focus: null, sidebar: true, rail: true, sidebarWidth: null, railWidth: null, splits: {}, sidebarOnly: false };
  const sidebars = [];
  let seq = 0;
  let root = null;
  let sidebarEl = null;
  let panesEl = null;
  let railEl = null;
  let railHandle = null;
  const EMPTY_TEXT = "Pick a chat, or start a new one.";
  let emptyEl = null;
  let emptyText = null;
  let emptyNew = null;
  let emptyRun = null;
  let emptyBar = null;
  let sidebarHandle = null;
  let saveTimer = null;
  let started = false;

  function byId(id) {
    return S.panes.find(function (p) {
      return p.id === id;
    }) || null;
  }

  function focused() {
    return byId(S.focus);
  }

  function publicPane(p) {
    return { id: p.id, kind: p.kind, chatId: p.chatId, params: p.params, focused: p.id === S.focus };
  }

  function panes() {
    return S.panes.map(publicPane);
  }

  function save() {
    if (saveTimer != null) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(function () {
      saveTimer = null;
      const layout = {
        panes: S.panes.map(function (p) {
          return { kind: p.kind, chatId: p.chatId, params: p.params, server: serverOfPane(p) };
        }),
        focus: S.panes.findIndex(function (p) {
          return p.id === S.focus;
        }),
        sidebar: S.sidebar,
        rail: S.rail,
        sidebarWidth: S.sidebarWidth,
        railWidth: S.railWidth,
        splits: S.splits,
        sidebarOnly: S.sidebarOnly,
      };
      CC.Servers.appKv().set("ui", "layout", layout).catch(function (e) {
        console.warn("layout not saved:", e && e.message);
      });
    }, SAVE_DELAY_MS);
  }

  // Saved with the layout: a restored chat can't wait for its server's list to say where it is.
  function serverOfPane(p) {
    const row = p.chatId != null && CC.Chats != null ? CC.Chats.get(p.chatId) : null;
    return row != null && row.server != null ? row.server : p.server || null;
  }

  function runtimeFor(chatId, server) {
    if (chatId == null || CC.Chats == null) {
      return null;
    }
    try {
      return CC.Chats.open(chatId, { server: server });
    } catch (e) {
      console.error("runtime for " + chatId, e);
      return null;
    }
  }

  const SHOW_SIDEBAR = { icon: "sidebar", label: "Show chats", run: toggleSidebar };

  function headButton(p) {
    return !S.sidebar && S.panes[0] === p ? [SHOW_SIDEBAR] : [];
  }

  function nextChat() {
    if (CC.Chats == null) {
      return null;
    }
    const shown = new Set(S.panes.map(function (p) {
      return p.chatId;
    }));
    return CC.Chats.rows().find(function (r) {
      return r.kind === "chat" && !shown.has(r.id);
    }) || null;
  }

  function shellActions(p) {
    const actions = [];
    if (p.kind === "chat" && S.panes.length < MAX_PANES && nextChat() != null) {
      actions.push({
        icon: "split",
        label: "Open another chat beside this one",
        run: function () {
          const next = nextChat();
          if (next != null) {
            open({ kind: "chat", chatId: next.id }, { beside: true });
          }
        },
      });
    }
    if (S.panes.length === 1 && p.chatId != null) {
      actions.push({ icon: "rail", label: "Show or hide details", on: S.rail, cls: "cc-rail-toggle", run: toggleRail });
    }
    if (S.panes.length > 1 || p.kind !== "chat") {
      actions.push({
        icon: "x",
        label: "Close pane",
        run: function () {
          close(p.id);
        },
      });
    }
    return actions;
  }

  function actionEl(a) {
    const b = CC.ui.iconButton({ icon: a.icon, label: a.label, on: a.on, onClick: a.run });
    if (a.cls != null) {
      b.classList.add(a.cls);
    }
    return b;
  }

  function renderHead(p) {
    const def = CC.Panes.get(p.kind);
    let title = "";
    try {
      title = def.title(p.ctx);
    } catch (e) {
      console.error("pane title", e);
    }
    p.headEl.set({
      title: title,
      lead: headButton(p).map(actionEl),
      actions: (def.actions != null ? def.actions(p.ctx) : []).concat(shellActions(p)).map(actionEl),
    });
  }

  function mountPane(p) {
    const def = CC.Panes.get(p.kind);
    p.ctx = {
      paneId: p.id,
      chatId: p.chatId,
      runtime: runtimeFor(p.chatId, p.server),
      params: p.params,
      shell: api,
      // A pane's own change of what it shows, saved with the layout.
      setParams: function (params) {
        if (byId(p.id) === p) {
          p.params = params;
          p.ctx.params = params;
          save();
        }
      },
      setTitle: function () {
        if (byId(p.id) === p) {
          renderHead(p);
          changed();
        }
      },
    };
    p.el = el("section", "cc-pane");
    p.el.dataset.paneId = p.id;
    p.el.dataset.kind = p.kind;
    p.headEl = CC.ui.bar({ cls: "cc-pane-head", titleCls: "cc-pane-title", title: "" });
    p.bodyEl = el("div", "cc-pane-body");
    p.el.appendChild(p.headEl);
    p.el.appendChild(p.bodyEl);
    p.el.appendChild(paneHandle(p));
    try {
      p.handle = def.mount(p.bodyEl, p.ctx) || {};
    } catch (e) {
      console.error("pane " + p.kind, e);
      p.handle = {};
      p.bodyEl.appendChild(el("div", "cc-empty", "This pane couldn't load: " + e.message));
    }
  }

  function unmountPane(p) {
    if (p.handle != null && p.handle.unmount != null) {
      try {
        p.handle.unmount();
      } catch (e) {
        console.error("pane unmount " + p.kind, e);
      }
    }
    p.el.remove();
  }

  function renderRail() {
    const single = S.panes.length === 1 ? S.panes[0] : null;
    const wanted = S.rail && !S.sidebarOnly && single != null && single.chatId != null;
    railEl.hidden = !wanted;
    railHandle.hidden = !wanted;
    const next = wanted ? single.ctx : null;
    if (railEl.ccCtx !== next) {
      railEl.ccCtx = next;
      CC.Rail.show(next);
    }
  }

  function changed() {
    CC.bus.emit("shell:changed", { panes: panes(), sidebarOnly: S.sidebarOnly });
  }

  function render() {
    root.classList.toggle("no-sidebar", !S.sidebar && !S.sidebarOnly);
    root.classList.toggle("is-sidebar-only", S.sidebarOnly);
    S.panes.forEach(function (p, i) {
      p.el.classList.toggle("is-focused", p.id === S.focus);
      // Moving a node drops the focus inside it, also to where it already is.
      if (panesEl.children[i] !== p.el) {
        panesEl.insertBefore(p.el, panesEl.children[i] || null);
      }
      renderHead(p);
    });
    panesEl.classList.toggle("is-many", S.panes.length > 1);
    applySplits();
    emptyEl.hidden = S.panes.length > 0;
    emptyBar.hidden = S.panes.length > 0 || S.sidebar;
    renderRail();
    changed();
  }

  function makePane(target) {
    if (CC.Panes.get(target.kind) == null) {
      throw new Error("no pane kind " + target.kind);
    }
    seq += 1;
    const p = { id: "p" + seq, kind: target.kind, chatId: target.chatId != null ? target.chatId : null, params: target.params || {}, server: target.server || null, seen: 0 };
    mountPane(p);
    return p;
  }

  // Opened again with params. A pane with `update` follows them itself; for any other the same params change nothing, and new ones remount it.
  function retarget(p, params) {
    if (params == null) {
      return;
    }
    if (p.handle != null && p.handle.update != null) {
      try {
        p.handle.update(params);
      } catch (e) {
        console.error("pane update " + p.kind, e);
      }
      return;
    }
    if (JSON.stringify(params) !== JSON.stringify(p.params)) {
      unmountPane(p);
      p.params = params;
      mountPane(p);
      render();
      save();
    }
  }

  function sameTarget(p, target) {
    const chatId = target.chatId != null ? target.chatId : null;
    if (p.kind === "terminal" && target.kind === "terminal") {
      return p.params.id === target.params.id;
    }
    return p.kind === target.kind && p.chatId === chatId;
  }

  function rightmost(wanted) {
    for (let i = S.panes.length - 1; i >= 0; i--) {
      if (wanted(S.panes[i])) {
        return i;
      }
    }
    return -1;
  }

  // The chat pane last worked in, whatever is focused now.
  function lastChatPane() {
    let best = -1;
    S.panes.forEach(function (p, i) {
      if (p.kind === "chat" && (best < 0 || p.seen >= S.panes[best].seen)) {
        best = i;
      }
    });
    return best;
  }

  // Where a pane goes: {at, replace}. The one rule of what an open may displace.
  // Without `beside` it takes the focused pane, except that a chat goes to a chat, terminal or agent pane: a diff, file, plan, pins or Settings being read stays. A terminal taken keeps running, its row brings it back.
  // With `beside` it goes after the focused pane; when full it takes the rightmost other pane, a chat for a chat if there is one, so what you're reading stays.
  function placement(target, beside) {
    const isChat = target.kind === "chat";
    const at = S.panes.findIndex(function (p) {
      return p.id === S.focus;
    });
    const room = S.panes.length < MAX_PANES;
    if (S.panes.length === 0) {
      return { at: 0, replace: false };
    }
    if (beside) {
      if (room) {
        return { at: at + 1, replace: false };
      }
      const other = isChat ? rightmost(function (p) { return p.kind === "chat" && p.id !== S.focus; }) : -1;
      return { at: other >= 0 ? other : rightmost(function (p) { return p.id !== S.focus; }), replace: true };
    }
    if (!isChat || S.panes[at].kind === "chat" || S.panes[at].kind === "terminal" || S.panes[at].kind === "agent") {
      return { at: at, replace: true };
    }
    const chat = lastChatPane();
    if (chat >= 0) {
      return { at: chat, replace: true };
    }
    // No chat pane at all: it gets one on the left, or the first pane that isn't being read.
    return room ? { at: 0, replace: false } : { at: at === 0 ? 1 : 0, replace: true };
  }

  function open(target, opts) {
    const beside = opts != null && opts.beside === true;
    leaveSidebarOnly();
    const existing = S.panes.find(function (p) {
      return sameTarget(p, target);
    });
    if (existing != null) {
      // Going to a chat that stopped while it was on screen brings it back, as opening any stopped chat does.
      runtimeFor(existing.chatId);
      retarget(existing, target.params);
      focus(existing.id);
      return existing.id;
    }
    const p = makePane(target);
    const place = placement(target, beside);
    if (place.replace) {
      unmountPane(S.panes[place.at]);
      S.panes[place.at] = p;
    } else {
      S.panes.splice(place.at, 0, p);
    }
    S.focus = p.id;
    markSeen(p);
    render();
    save();
    // A chat that took a while to start can arrive while a field elsewhere is being typed in. Beside, the caller knows why it opened.
    if (beside || !typing()) {
      callFocus(p);
    }
    return p.id;
  }

  function close(paneId) {
    const at = S.panes.findIndex(function (p) {
      return p.id === paneId;
    });
    if (at < 0) {
      return;
    }
    unmountPane(S.panes[at]);
    S.panes.splice(at, 1);
    if (S.focus === paneId) {
      const next = S.panes[Math.max(0, at - 1)];
      S.focus = next != null ? next.id : null;
    }
    render();
    save();
    focusIfNowhere();
  }

  // Muxy keeps Cmd+W from the page, so this is the only place to hear it. Reloading from Settings has that window focused, so it isn't refused.
  function closeFocusedInstead() {
    const p = focused();
    if (p == null || S.panes.length < 2 || S.sidebarOnly || !CC.host.app.focused()) {
      return false;
    }
    closeShown(p);
    return true;
  }

  function closeFocusedPane() {
    const p = focused();
    if (p != null && !S.sidebarOnly) {
      closeShown(p);
    }
  }

  // The sidebar row a pane closes as: a chat, or a terminal with its own row. A chat's terminal has none, Claude runs in it.
  function rowOf(p) {
    if (CC.Chats == null) {
      return null;
    }
    if (p.kind === "chat" && p.chatId != null) {
      return p.chatId;
    }
    if (p.kind === "terminal" && p.params != null && p.params.id != null && CC.Chats.chatOfPane(p.params.id) == null) {
      return "pane:" + p.params.id;
    }
    return null;
  }

  // Cmd+W: a chat or a terminal closes as from its row's ×, so it leaves the list too, with every pane showing it; a terminal's shell ends. Any other pane just closes.
  function closeShown(p) {
    const row = rowOf(p);
    if (row == null) {
      close(p.id);
      return;
    }
    S.panes.filter(function (x) {
      return rowOf(x) === row;
    }).forEach(function (x) {
      close(x.id);
    });
    Promise.resolve(CC.Chats.close(row)).catch(function (e) {
      console.warn("not closed", row, e);
      CC.ui.toast("Couldn't close it: " + (e && e.message ? e.message : e), { level: "error" });
    });
  }

  // As the pane's own button, or a new chat in the same place when every chat is on screen.
  function splitChat() {
    const p = focused();
    if (p == null || S.sidebarOnly || S.panes.length >= MAX_PANES) {
      return;
    }
    const next = nextChat();
    if (next != null) {
      open({ kind: "chat", chatId: next.id }, { beside: true });
      return;
    }
    const row = p.chatId != null && CC.Chats != null ? CC.Chats.get(p.chatId) : null;
    if (row == null) {
      return;
    }
    CC.Chats.create({ cwd: row.cwd, server: row.server }).then(function (id) {
      open({ kind: "chat", chatId: id }, { beside: true });
    }).catch(function (e) {
      console.warn("couldn't start a chat beside", e);
      CC.ui.toast("The chat didn't start: " + e.message, { level: "error" });
    });
  }

  // What the page with no panes offers: {text, run}, or null for the plain hint.
  function setEmptyOffer(offer) {
    emptyText.textContent = offer != null ? offer.text : EMPTY_TEXT;
    emptyRun = offer != null ? offer.run : null;
    emptyNew.hidden = offer == null;
  }

  function callFocus(p) {
    if (p.handle != null && p.handle.focus != null) {
      p.handle.focus();
    }
  }

  function typing() {
    const a = document.activeElement;
    return a != null && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable === true);
  }

  // For what nobody asked to focus: closing a pane took the focus along, or the app just opened.
  function focusIfNowhere() {
    const a = document.activeElement;
    const p = focused();
    if (p != null && (a == null || a === document.body)) {
      callFocus(p);
    }
  }

  function markSeen(p) {
    seq += 1;
    p.seen = seq;
  }

  function setFocus(paneId) {
    if (S.focus === paneId || byId(paneId) == null) {
      return false;
    }
    S.focus = paneId;
    markSeen(byId(paneId));
    S.panes.forEach(function (p) {
      p.el.classList.toggle("is-focused", p.id === S.focus);
    });
    save();
    changed();
    return true;
  }

  function focus(paneId) {
    if (byId(paneId) != null) {
      leaveSidebarOnly();
    }
    setFocus(paneId);
    const p = byId(paneId);
    if (p != null) {
      callFocus(p);
    }
  }

  // In the sidebar-only state the sidebar is all there is, and the rail isn't there to toggle.
  function toggleSidebar() {
    if (S.sidebarOnly) {
      return;
    }
    S.sidebar = !S.sidebar;
    render();
    save();
    focusIfNowhere();
  }

  function toggleRail() {
    if (S.sidebarOnly) {
      return;
    }
    S.rail = !S.rail;
    render();
    save();
  }

  function leaveSidebarOnly() {
    if (S.sidebarOnly) {
      S.sidebarOnly = false;
      render();
      save();
    }
  }

  // The sidebar-only state: the sidebar over the app's whole pane, no chat pane and no rail, whether the sidebar was collapsed or not.
  // The panes stay mounted and laid out under it, unseen, so they come back as they were. Opening or focusing any pane leaves the state.
  function setSidebarOnly(on) {
    if (on !== true) {
      leaveSidebarOnly();
      focusIfNowhere();
    } else if (!S.sidebarOnly) {
      S.sidebarOnly = true;
      const a = document.activeElement;
      if (a != null && a.closest != null && a.closest(".cc-main") != null) {
        a.blur();
      }
      render();
      save();
    }
  }

  function mountSidebar() {
    if (sidebarEl == null) {
      return;
    }
    if (sidebarHandle != null && sidebarHandle.unmount != null) {
      sidebarHandle.unmount();
    }
    sidebarHandle = null;
    sidebarEl.replaceChildren();
    const real = sidebars.filter(function (s) {
      return s.fallback !== true;
    });
    const def = real.length > 0 ? real[real.length - 1] : sidebars[sidebars.length - 1];
    if (def == null) {
      return;
    }
    try {
      sidebarHandle = def.factory(sidebarEl, { shell: api }) || null;
    } catch (e) {
      console.error("sidebar", e);
      sidebarEl.appendChild(el("div", "cc-empty", "The sidebar couldn't load: " + e.message));
    }
  }

  // factory(el, {shell}) → {unmount()}. The last real one wins over any fallback.
  function sidebar(factory, opts) {
    sidebars.push({ factory: factory, fallback: opts != null && opts.fallback === true });
    if (started) {
      mountSidebar();
    }
  }

  function clampWidth(side, wanted) {
    const limits = WIDTHS[side];
    const other = side === "sidebar" ? (railEl.hidden ? 0 : railEl.getBoundingClientRect().width) : (S.sidebar ? sidebarEl.getBoundingClientRect().width : 0);
    const main = Math.max(MIN_MAIN, S.panes.length * MIN_PANE);
    const room = Math.min(limits.max, Math.floor(window.innerWidth * MAX_SHARE), window.innerWidth - other - main);
    return Math.round(Math.max(limits.min, Math.min(room, wanted)));
  }

  // On the root, as things outside the shell (the notices) line up with the sidebar too.
  function applyWidth(side, width) {
    S[side + "Width"] = width;
    if (width != null) {
      document.documentElement.style.setProperty(WIDTHS[side].cssVar, width + "px");
    }
  }

  // A divider. Pointer capture keeps the drag on this element wherever the pointer goes; arrows do the same from the keyboard.
  // begin() reads the widths now and returns fn(dx), which applies a move of dx px from them.
  function dragHandle(cls, label, begin) {
    const handle = el("div", "cc-resize " + cls);
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", label);
    handle.tabIndex = 0;
    let drag = null;
    handle.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) {
        return;
      }
      e.preventDefault();
      drag = { x: e.clientX, apply: begin() };
      if (handle.setPointerCapture != null && e.pointerId != null) {
        handle.setPointerCapture(e.pointerId);
      }
      root.classList.add("is-resizing");
    });
    handle.addEventListener("pointermove", function (e) {
      if (drag != null) {
        drag.apply(e.clientX - drag.x);
      }
    });
    function end() {
      if (drag != null) {
        drag = null;
        root.classList.remove("is-resizing");
        save();
      }
    }
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        begin()(e.key === "ArrowRight" ? KEY_STEP : -KEY_STEP);
        save();
      }
    });
    return handle;
  }

  function resizeHandle(side, sideEl, sign) {
    return dragHandle("cc-resize-" + side, side === "sidebar" ? "Resize chats" : "Resize details", function () {
      const width = sideEl.getBoundingClientRect().width;
      return function (dx) {
        applyWidth(side, clampWidth(side, width + sign * dx));
      };
    });
  }

  // chat+side, chat+chat, chat+chat+side: file, plan or Review in the same place keep one width, and so does whichever chat is shown.
  function shapeOf() {
    return S.panes.map(function (p) {
      return p.kind === "chat" ? "chat" : "side";
    }).join("+");
  }

  function applySplits() {
    const shares = S.panes.length > 1 ? S.splits[shapeOf()] : null;
    S.panes.forEach(function (p, i) {
      p.el.style.flexGrow = shares != null ? String(shares[i]) : "";
    });
  }

  // The divider on a pane's left edge, hidden on the first. It moves only the two panes it separates.
  function paneHandle(p) {
    return dragHandle("cc-resize-pane", "Resize panes", function () {
      const at = S.panes.indexOf(p);
      const widths = S.panes.map(function (x) {
        return x.el.getBoundingClientRect().width;
      });
      const pair = widths[at - 1] + widths[at];
      const total = widths.reduce(function (a, b) {
        return a + b;
      }, 0);
      return function (dx) {
        const left = Math.max(MIN_PANE, Math.min(pair - MIN_PANE, widths[at - 1] + dx));
        S.splits[shapeOf()] = widths.map(function (w, i) {
          const width = i === at - 1 ? left : i === at ? pair - left : w;
          return Math.round(width / total * 10000) / 10000;
        });
        applySplits();
      };
    });
  }

  function validSplits(saved) {
    const out = {};
    Object.keys(saved != null && typeof saved === "object" ? saved : {}).forEach(function (shape) {
      const shares = saved[shape];
      const fits = /^(chat|side)(\+(chat|side)){1,2}$/.test(shape) && Array.isArray(shares) && shares.length === shape.split("+").length;
      if (fits && shares.every(function (n) { return typeof n === "number" && n > 0; })) {
        out[shape] = shares;
      }
    });
    return out;
  }

  function buildDom(container) {
    root = el("div", "cc-shell");
    sidebarEl = el("aside", "cc-sidebar");
    sidebarEl.setAttribute("aria-label", "Chats");
    const main = el("main", "cc-main");
    panesEl = el("div", "cc-panes");
    emptyEl = el("div", "cc-empty cc-empty-panes");
    emptyText = el("div", null, EMPTY_TEXT);
    emptyNew = CC.ui.button({ label: "New chat", primary: true, onClick: function () { emptyRun(); } });
    emptyNew.hidden = true;
    emptyEl.append(emptyText, emptyNew);
    main.appendChild(panesEl);
    emptyBar = CC.ui.bar({ cls: "cc-pane-head cc-empty-bar", title: "", lead: [actionEl(SHOW_SIDEBAR)] });
    main.appendChild(emptyEl);
    main.appendChild(emptyBar);
    railEl = el("aside", "cc-rail");
    railEl.setAttribute("aria-label", "Chat details");
    railHandle = resizeHandle("rail", railEl, -1);
    root.appendChild(sidebarEl);
    root.appendChild(resizeHandle("sidebar", sidebarEl, 1));
    root.appendChild(main);
    root.appendChild(railHandle);
    root.appendChild(railEl);
    container.replaceChildren(root);

    // Bubbling inside the shell is enough: clicks and focus outside it are floating things, which don't change the focused pane.
    function followFocus(e) {
      if (e.target.closest != null && e.target.closest(".cc-resize") != null) {
        return;
      }
      const section = e.target.closest != null ? e.target.closest(".cc-pane") : null;
      if (section != null) {
        setFocus(section.dataset.paneId);
      }
    }
    root.addEventListener("pointerdown", followFocus);
    root.addEventListener("focusin", followFocus);
  }

  async function readKv(key) {
    try {
      return await CC.Servers.appKv().get("ui", key);
    } catch (e) {
      console.warn("kv ui/" + key + " not read:", e && e.message);
      return null;
    }
  }

  function restorePanes(layout) {
    const saved = layout != null && Array.isArray(layout.panes) ? layout.panes : [];
    saved.slice(0, MAX_PANES).forEach(function (t) {
      if (CC.Panes.get(t.kind) != null) {
        S.panes.push(makePane(t));
      }
    });
    if (S.panes.length > 0) {
      const wanted = S.panes[layout.focus] || S.panes[0];
      S.focus = wanted.id;
    }
  }

  async function start(container) {
    const layout = await readKv("layout");
    const rail = await readKv("rail");
    buildDom(container);
    if (layout != null) {
      S.sidebar = layout.sidebar !== false;
      S.rail = layout.rail !== false;
      S.splits = validSplits(layout.splits);
      S.sidebarOnly = layout.sidebarOnly === true;
      ["sidebar", "rail"].forEach(function (side) {
        const saved = layout[side + "Width"];
        if (typeof saved === "number" && saved >= WIDTHS[side].min && saved <= WIDTHS[side].max) {
          applyWidth(side, saved);
        }
      });
    }
    CC.Rail.attach(railEl, rail);
    CC.Keys.setPaneSource(function () {
      const p = focused();
      return p != null && !S.sidebarOnly ? p.handle : null;
    });
    CC.Keys.bind("mod+b", { scope: "global", run: toggleSidebar });
    CC.Keys.bind("mod+alt+b", { scope: "global", run: toggleRail });
    CC.host.app.onBeforeClose(closeFocusedInstead);
    // Both reach the page once the installer moved Muxy's own. Closing the last pane leaves the empty page, never the app.
    CC.Keys.bind("cmd+w", { scope: "global", run: closeFocusedPane });
    CC.Keys.bind("cmd+d", { scope: "global", run: splitChat });
    started = true;
    mountSidebar();
    restorePanes(layout);
    render();
    focusIfNowhere();
  }

  const api = {
    start: start,
    open: open,
    close: close,
    focus: focus,
    focused: function () {
      const p = focused();
      return p != null ? publicPane(p) : null;
    },
    panes: panes,
    toggleSidebar: toggleSidebar,
    toggleRail: toggleRail,
    setSidebarOnly: setSidebarOnly,
    isSidebarOnly: function () {
      return S.sidebarOnly;
    },
    sidebar: sidebar,
    setEmptyOffer: setEmptyOffer,
  };
  return api;
})();
