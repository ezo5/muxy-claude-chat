// Puts the flow into the chat pane's slots and offers it to other panes. All of a view lives in its share, found by the slot ctx or pane id:
// flow (slot `flow`), live line (slot `flowEnd`, order 0: C3's cards go after it), find and jump button (slot `overlay`).
//
//   CC.Conversation.mount(el, {store | runtime, chatId, paneId, cwd, shell, readOnly, file, loadOlder, emptyText}) → {unmount, focus, onKey, flow}
//
// mount is for panes of their own, such as the subagent transcript: it brings its own scroller. readOnly drops the live line and every
// action except copy.
CC.Conversation = (function () {
  const el = CC.util.el;
  const FIND_ROOTS = ".cv-bubble-text, .cv-answer > .md, .cv-step-label";
  const MODES = ["normal", "thinking", "verbose"];
  const MODE_LABEL = { normal: "Normal", thinking: "Thinking", verbose: "Verbose" };

  const shares = new WeakMap();   // slot ctx → share
  const live = new Set();         // every mounted share

  function makeEnv(ctx, scroller) {
    const runtime = CC.conversationSample != null ? CC.conversationSample.adapt(ctx.runtime) : ctx.runtime;
    const store = ctx.store || (runtime != null ? runtime.store : null);
    if (store == null) {
      throw new Error("the conversation needs a store");
    }
    const readOnly = ctx.readOnly === true || (runtime != null && runtime.readOnly === true);
    return {
      store: store,
      runtime: runtime || null,
      chatId: ctx.chatId != null ? ctx.chatId : null,
      paneId: ctx.paneId != null ? ctx.paneId : null,
      cwd: ctx.cwd || (runtime != null && runtime.cwd) || null,
      shell: ctx.shell || null,
      readOnly: readOnly,
      scroller: scroller,
      emptyText: ctx.emptyText || null,
      pins: !readOnly && runtime != null ? CC.Pins.of(runtime) : null,
      file: ctx.file || (runtime != null && runtime.transcriptFile != null ? function () {
        return runtime.transcriptFile();
      } : null),
      loadOlder: ctx.loadOlder || (runtime != null && runtime.loadOlder != null ? function () {
        return runtime.loadOlder();
      } : null),
      quote: readOnly ? null : function (text) {
        const composer = CC.Composer != null ? CC.Composer.ofPane(ctx.paneId) || CC.Composer.of(ctx.chatId) : null;
        if (composer != null) {
          composer.addQuote(text);
        } else {
          CC.ui.toast("Open the chat to quote this");
        }
      },
    };
  }

  // The flow of a chat no pane shows, by its runtime: at most one each, gone with the runtime or at a reset of its store.
  const parked = new WeakMap();
  const BIG_FLOW_ITEMS = 3000;
  let bigParked = null;

  // keep: a chat pane's, whose flow outlives the pane. Opening its chat again takes it back instead of building it again.
  function makeShare(host, ctx, scroller, keep) {
    const env = makeEnv(ctx, scroller);
    const back = keep ? parked.get(ctx.runtime) : null;
    let flow = null;
    if (back != null && back.parked) {
      parked.delete(ctx.runtime);
      back.attach(host, env);
      flow = back;
    } else {
      flow = new CC.Flow(host, env);
    }
    const share = { env: flow.env, flow: flow, overlay: null, offs: [], keep: keep === true, runtime: ctx.runtime };
    if (env.pins != null) {
      share.offs.push(env.pins.on(function () {
        flow.refreshPins();
      }));
    }
    if (env.runtime != null && env.runtime.ready != null) {
      env.runtime.ready.catch(function (e) {
        flow.startError = e && e.message ? e.message : String(e);
        flow.updateEmpty();
      });
    }
    if (flow !== back) {
      flow.render(env.store.items.slice());
      flow.scrollToBottom(false);
    }
    flow.updateOlder();
    live.add(share);
    return share;
  }

  function dropShare(share) {
    live.delete(share);
    share.offs.forEach(function (off) {
      off();
    });
    const old = share.keep ? parked.get(share.runtime) : null;
    if (!share.keep || share.runtime.disposed === true || (old != null && old.parked) || !roomFor(share.flow)) {
      share.flow.unmount();
      return;
    }
    share.flow.park();
    parked.set(share.runtime, share.flow);
  }

  // A flow that grew back to most of a long chat (find, a far jump) is worth keeping only for a place up in it, and only one at a time, as 8 of them are too many nodes.
  function roomFor(flow) {
    if (flow.builtItems() < BIG_FLOW_ITEMS) {
      return true;
    }
    if (flow.pinned) {
      return false;
    }
    if (bigParked != null && bigParked !== flow && bigParked.parked) {
      bigParked.unmount();
    }
    bigParked = flow;
    return true;
  }

  // Find and jump to latest float over the scroller; --cv-bottom is where the scroller ends inside `host`.
  function mountOverlay(host, share) {
    const flow = share.flow;
    const s = flow.scroller;
    const box = el("div", "cv-overlay");
    host.appendChild(box);
    const jump = el("button", "cv-jump");
    jump.type = "button";
    jump.hidden = true;
    jump.appendChild(CC.ui.icon("down", 14));
    const badge = el("span", "cv-jump-badge");
    jump.appendChild(badge);
    jump.addEventListener("click", function () {
      flow.following = true;
      flow.scrollToBottom(true);
    });
    box.appendChild(jump);
    const find = new CC.Find({
      scroller: s,
      root: flow.log,
      mount: box,
      roots: FIND_ROOTS,
      placeholder: "Find in conversation",
      highlight: "cc-find",
      prepare: function () {
        flow.buildAll();
      },
      onClose: function () {
        focusComposer(host);
      },
    });
    const nav = new CC.PromptNav(flow);

    function place() {
      const outer = box.getBoundingClientRect();
      const inner = s.getBoundingClientRect();
      box.style.setProperty("--cv-top", Math.max(0, inner.top - outer.top) + "px");
      box.style.setProperty("--cv-bottom", Math.max(0, outer.bottom - inner.bottom) + "px");
    }

    function paintJump() {
      jump.hidden = flow.pinned || flow.atBottom();
      jump.classList.toggle("is-fresh", flow.fresh === true);
      badge.textContent = flow.unseen > 9 ? "9+" : flow.unseen > 0 ? String(flow.unseen) : "";
      const title = flow.unseen > 0 ? CC.conv.plural(flow.unseen, "new message", "new messages") : "Jump to latest";
      jump.title = title;
      jump.setAttribute("aria-label", title);
    }

    flow.onChange = function () {
      paintJump();
      find.refresh();
    };
    let ro = null;
    if (typeof ResizeObserver === "function") {
      ro = new ResizeObserver(function () {
        place();
        paintJump();
      });
      ro.observe(s);
      ro.observe(flow.root);
    }
    place();
    paintJump();
    share.overlay = { find: find, nav: nav };
    return {
      unmount: function () {
        flow.onChange = null;
        if (ro != null) {
          ro.disconnect();
        }
        find.dispose();
        share.overlay = null;
        host.replaceChildren();
      },
    };
  }

  function focusComposer(from) {
    const chat = from.closest(".cc-chat");
    const field = chat != null ? chat.querySelector('[data-cc-slot="composer"] textarea, [data-cc-slot="composer"] [contenteditable]') : null;
    if (field != null) {
      field.focus();
    }
  }

  // Slots. flow always mounts first, overlay and flowEnd find it through the ctx they share.
  function slotFlow(host, ctx) {
    const scroller = host.closest(".cc-chat-scroll");
    if (scroller == null || ctx.runtime == null) {
      return null;
    }
    const share = makeShare(host, ctx, scroller, true);
    shares.set(ctx, share);
    return {
      unmount: function () {
        shares.delete(ctx);
        dropShare(share);
      },
    };
  }

  function slotLive(host, ctx) {
    const share = shares.get(ctx);
    if (share == null || share.env.readOnly) {
      return null;
    }
    return CC.LiveLine.mount(host, { store: share.env.store, runtime: share.env.runtime, chatId: share.env.chatId });
  }

  function slotOverlay(host, ctx) {
    const share = shares.get(ctx);
    return share != null ? mountOverlay(host, share) : null;
  }

  function mount(host, ctx) {
    const root = el("div", "cc-chat cv-own");
    const scroll = el("div", "cc-chat-scroll");
    const column = el("div", "cc-chat-column");
    const flowHost = el("div");
    column.appendChild(flowHost);
    scroll.appendChild(column);
    const overlayHost = el("div", "cc-slot-overlay");
    root.append(scroll, overlayHost);
    host.appendChild(root);
    const share = makeShare(flowHost, ctx, scroll);
    const liveHost = share.env.readOnly ? null : el("div");
    let liveLine = null;
    if (liveHost != null) {
      column.appendChild(liveHost);
      liveLine = CC.LiveLine.mount(liveHost, { store: share.env.store, runtime: share.env.runtime, chatId: share.env.chatId });
    }
    const overlay = mountOverlay(overlayHost, share);
    return {
      flow: share.flow,
      focus: function () {
        scroll.focus();
      },
      onKey: function (e) {
        return onKey(share, e);
      },
      unmount: function () {
        overlay.unmount();
        if (liveLine != null) {
          liveLine.unmount();
        }
        dropShare(share);
        host.replaceChildren();
      },
    };
  }

  function focusedShare() {
    const pane = CC.Shell != null ? CC.Shell.focused() : null;
    if (pane == null) {
      return null;
    }
    return Array.from(live).find(function (s) {
      return s.env.paneId === pane.id;
    }) || null;
  }

  function promptKey(share, dir, e) {
    const t = e != null ? e.target : null;
    if (t != null && (t.tagName === "TEXTAREA" || t.tagName === "INPUT") && t.value !== "") {
      return false;
    }
    if (share == null || share.overlay == null) {
      return false;
    }
    share.overlay.nav.go(dir);
    return true;
  }

  function openFind(share) {
    if (share == null || share.overlay == null) {
      return false;
    }
    share.overlay.find.open();
    return true;
  }

  // For a pane of its own, whose mount gets the keys directly.
  function onKey(share, e) {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === "f") {
      return openFind(share);
    }
    if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      return promptKey(share, e.key === "ArrowUp" ? -1 : 1, e);
    }
    return false;
  }

  function setViewMode(mode) {
    CC.settings.set("viewMode", mode);
    CC.ui.toast("View: " + MODE_LABEL[mode]);
  }

  function cycleViewMode() {
    setViewMode(MODES[(MODES.indexOf(CC.Flow.viewMode()) + 1) % MODES.length]);
  }

  CC.bus.on("settings:changed", function (e) {
    if (e != null && e.key === "viewMode") {
      const mode = CC.Flow.viewMode();
      live.forEach(function (share) {
        share.flow.setMode(mode);
      });
    }
  });

  function chatFocused() {
    return focusedShare() != null;
  }

  CC.Keys.bind("mod+f", { scope: "pane", when: chatFocused, run: function () {
    return openFind(focusedShare());
  } });
  CC.Keys.bind("alt+arrowup", { scope: "pane", when: chatFocused, run: function (e) {
    return promptKey(focusedShare(), -1, e);
  } });
  CC.Keys.bind("alt+arrowdown", { scope: "pane", when: chatFocused, run: function (e) {
    return promptKey(focusedShare(), 1, e);
  } });
  // In a field with text it stays the Mac's native delete to the end of the line.
  CC.Keys.bind("ctrl+k", { scope: "pane", when: chatFocused, run: function (e) {
    const t = e.target;
    if ((t.tagName === "TEXTAREA" || t.tagName === "INPUT") && t.value !== "") {
      return false;
    }
    focusedShare().flow.wipe();
    return true;
  } });
  // As in a Mac terminal; a field has no use for this key, so also with text in it.
  CC.Keys.bind("cmd+k", { scope: "pane", when: chatFocused, run: function () {
    focusedShare().flow.wipe();
  } });
  CC.Keys.bind("ctrl+o", { scope: "global", run: function () {
    cycleViewMode();
  } });

  // The webview blocks downloads, so the file goes next to the project on the server.
  async function exportChat(runtime, title) {
    const store = runtime.store;
    const dir = store.meta.cwd || runtime.cwd || ".";
    try {
      for (let i = 0; store.hasOlder && i < 200; i++) {
        await runtime.loadOlder();
      }
      const text = CC.exportMarkdown(store, { title: title, cwd: dir });
      const d = new Date();
      const pad = function (n) {
        return String(n).padStart(2, "0");
      };
      const name = "claude-chat-export-" + d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + ".md";
      let res = null;
      for (let i = 0; i < text.length; i += 200000) {
        res = await CC.Servers.of(runtime).host.call("writeExport", { cwd: dir, name: name, text: text.slice(i, i + 200000), append: i > 0 });
      }
      CC.ui.toast("Exported to " + res.path);
    } catch (e) {
      CC.ui.toast("Export failed: " + (e && e.message ? e.message : String(e)), { level: "error" });
    }
  }

  function chatTitle(ctx) {
    const row = CC.Chats != null && CC.Chats.get != null ? CC.Chats.get(ctx.chatId) : null;
    return row != null && row.title ? row.title : "Conversation";
  }

  function openPins(chatId, shell) {
    (shell || CC.Shell).open({ kind: "pins", chatId: chatId }, { beside: true });
  }

  // Shown with the title: view mode, pins, export. Chained, as other packages may add theirs to the frame's actions.
  (function () {
    const def = CC.Panes.get("chat");
    if (def == null) {
      return;
    }
    const before = def.actions;
    def.actions = function (ctx) {
      const own = {
        icon: "gear",
        label: "Conversation options",
        run: function (e) {
          const mode = CC.Flow.viewMode();
          CC.ui.menu(MODES.map(function (m) {
            return { label: (m === mode ? "✓ " : "") + MODE_LABEL[m] + " view", run: function () {
              setViewMode(m);
            } };
          }).concat([{ separator: true }, { label: "Pinned messages", icon: "pin", run: function () {
            openPins(ctx.chatId, ctx.shell);
          } }, { label: "Export as Markdown", icon: "file", disabled: ctx.runtime == null || ctx.runtime.loadOlder == null, run: function () {
            exportChat(ctx.runtime, chatTitle(ctx));
          } }, { separator: true }, { label: "Settings…", run: function () {
            CC.SettingsView.open();
          } }]), { anchor: e.currentTarget });
        },
      };
      return (before != null ? before(ctx) : []).concat([own]);
    };
  })();

  // The view showing the chat, else a new pane beside it.
  async function shareOf(chatId, shell) {
    const find = function () {
      return Array.from(live).find(function (s) {
        return s.env.chatId === chatId && !s.env.readOnly;
      }) || null;
    };
    let share = find();
    if (share == null && shell != null) {
      shell.open({ kind: "chat", chatId: chatId }, { beside: true });
      await CC.util.sleep(0);
      share = find();
    }
    return share;
  }

  // A message by pin key or item id.
  async function jumpTo(chatId, id, shell) {
    const share = await shareOf(chatId, shell);
    if (share != null) {
      await share.flow.jumpTo(id);
    }
  }

  // A tool call by tool use id: older chunks load, its summary opens. The usage card's links.
  async function revealTool(chatId, toolId, shell) {
    const share = await shareOf(chatId, shell || CC.Shell);
    if (share != null) {
      await share.flow.revealTool(toolId);
    }
  }

  CC.ChatPane.slot("flow", slotFlow);
  CC.ChatPane.slot("flowEnd", slotLive, { order: 0 });
  CC.ChatPane.slot("overlay", slotOverlay);

  return { mount: mount, jumpTo: jumpTo, revealTool: revealTool, openPins: openPins, viewMode: function () {
    return CC.Flow.viewMode();
  }, setViewMode: setViewMode, exportChat: exportChat, focused: focusedShare };
})();
