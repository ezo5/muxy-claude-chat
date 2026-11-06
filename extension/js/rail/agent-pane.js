// The `agent` pane: a subagent's transcript, read-only, with live status. Its own Store fed by a Mirror (Hub.mirror), drawn by C2's
// conversation. params: {file, title, daemon, cwd}.
(function () {
  const el = CC.util.el;
  const TICK_MS = 1000;
  const LABELS = { connecting: "Loading", busy: "Running", idle: "Done", error: "Failed", stopped: "Stopped" };

  // What C2 reads from a runtime, with everything that would change the chat left out.
  function readOnlyRuntime(store, mirror, file) {
    return {
      id: "agent:" + file,
      server: mirror.server,
      readOnly: true,
      store: store,
      cwd: mirror.cwd,
      status: function () {
        return store.status;
      },
      meta: function () {
        return store.meta;
      },
      on: function (name, fn) {
        return store.on(name, fn);
      },
      mode: function () {
        return "terminal";
      },
      loadOlder: function () {
        return mirror.loadOlder();
      },
      transcriptFile: function () {
        return mirror.file;
      },
      sends: function () {
        return [];
      },
      previewsOf: function () {
        return [];
      },
    };
  }

  function mountConversation(host, ctx, runtime) {
    return CC.Conversation.mount(host, Object.assign({}, ctx, { runtime: runtime, chatId: null, readOnly: true }));
  }

  function markFor(status) {
    if (status === "busy" || status === "connecting") {
      return CC.ui.stateMark("busy");
    }
    if (status === "error") {
      return CC.ui.stateMark("error");
    }
    const icon = el("span", "cc-agent-icon is-" + (status === "idle" ? "done" : "stopped"));
    icon.appendChild(CC.ui.icon(status === "idle" ? "check" : "x", 12));
    return icon;
  }

  function mount(host, ctx) {
    const p = ctx.params || {};
    const parent = ctx.runtime != null ? CC.RailData.of(ctx.runtime) : null;
    const release = parent != null ? parent.acquire() : null;
    const store = new CC.Store();
    const mirror = new CC.Mirror(store, { key: "agent:" + p.file, server: CC.Servers.of(ctx.runtime), cwd: p.cwd || null, agentFile: p.file, daemon: p.daemon || null, onTui: function () {} });
    const root = el("div", "cc-agent-pane");
    const bar = el("div", "cc-agent-status");
    let mark = el("span", "cc-mark");
    const label = el("span", "cc-agent-state");
    const last = el("span", "cc-agent-last");
    bar.appendChild(mark);
    bar.appendChild(label);
    bar.appendChild(last);
    const flow = el("div", "cc-agent-flow");
    root.appendChild(bar);
    root.appendChild(flow);
    host.appendChild(root);

    let shownStatus = null;
    function rowOfParent() {
      return parent != null ? parent.rows.find(function (a) {
        return a.file === p.file || a.inline === p.file;
      }) || null : null;
    }

    function paint() {
      const status = store.status || "connecting";
      if (status !== shownStatus) {
        shownStatus = status;
        const next = markFor(status);
        mark.replaceWith(next);
        mark = next;
      }
      const row = rowOfParent();
      const start = row != null ? Date.parse(row.startTs) : NaN;
      const end = row != null && row.endTs != null && status !== "busy" ? Date.parse(row.endTs) : Date.now();
      label.textContent = (LABELS[status] || status) + (isNaN(start) ? "" : " · " + CC.util.fmtDuration(Math.max(0, end - start)));
      last.textContent = row != null && row.last ? row.last : "Read-only";
    }

    CC.Hub.of(mirror.server).start();
    mirror.begin();
    const conversation = mountConversation(flow, ctx, readOnlyRuntime(store, mirror, p.file));
    const offStore = store.on("state", paint);
    const offParent = parent != null ? parent.on(paint) : null;
    const tick = setInterval(paint, TICK_MS);
    paint();

    return {
      unmount: function () {
        clearInterval(tick);
        offStore();
        if (offParent != null) {
          offParent();
        }
        if (release != null) {
          release();
        }
        if (conversation != null && conversation.unmount != null) {
          conversation.unmount();
        }
        mirror.end();
      },
      focus: function () {
        if (conversation != null && conversation.focus != null) {
          conversation.focus();
        }
      },
    };
  }

  CC.Panes.register("agent", {
    title: function (ctx) {
      return ctx.params != null && ctx.params.title ? ctx.params.title : "Agent";
    },
    mount: mount,
  });
})();
