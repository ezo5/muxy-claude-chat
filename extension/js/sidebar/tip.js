// Hover card after 3 s on a row, under it (above it near the bottom), as wide as the sidebar. Hidden on leave, press and scroll. A redraw of the same row keeps it.
CC.SidebarTip = (function () {
  const DELAY_MS = 3000;
  const STATE_LABEL = { need: "Needs you", busy: "Working", bg: "Waiting on a background command", idle: "Ready", stopped: "Stopped", error: "Stopped with an error" };

  function data(row, projectName, now) {
    const terminal = row.kind === "terminal";
    const agents = (row.running || []).length;
    const state = terminal && row.state === "idle" ? "Terminal" : STATE_LABEL[row.state] || row.state;
    const meta = terminal ? [row.cwd] : [projectName, row.model ? CC.util.prettyModel(row.model) : null, row.cost > 0 ? CC.util.fmtCost(row.cost) : null,
      row.updatedAt != null ? CC.SidebarModel.ago(row.updatedAt, now) : null];
    return {
      title: row.title,
      state: state + (row.unread ? ", unread" : "") + (agents > 0 ? ", " + agents + (agents === 1 ? " agent" : " agents") : ""),
      tone: row.state === "need" ? "need" : null,
      line: row.state === "need" ? row.ask : row.now,
      prompt: row.preview != null ? row.preview.prompt || null : null,
      reply: row.preview != null ? row.preview.reply || null : null,
      meta: meta.filter(Boolean),
    };
  }

  function card(t) {
    const el = CC.util.el;
    const root = el("div", "sb-tip cc-floating");
    root.appendChild(el("div", "sb-tip-title", t.title));
    root.appendChild(el("div", "sb-tip-state" + (t.tone === "need" ? " is-need" : ""), t.state));
    if (t.line) {
      root.appendChild(el("div", "sb-tip-text", t.line));
    }
    if (t.prompt) {
      root.appendChild(el("div", "sb-tip-label", "Last prompt"));
      root.appendChild(el("div", "sb-tip-text", t.prompt));
    }
    if (t.reply) {
      root.appendChild(el("div", "sb-tip-label", "Last reply"));
      root.appendChild(el("div", "sb-tip-text", t.reply));
    }
    if (t.meta.length > 0) {
      root.appendChild(el("div", "sb-tip-meta", t.meta.join(" · ")));
    }
    return root;
  }

  // dataOf(id) → card data or null.
  function attach(tree, dataOf) {
    let timer = null;
    let shown = null;
    let hoverId = null;

    function hide() {
      clearTimeout(timer);
      timer = null;
      hoverId = null;
      if (shown != null) {
        shown.remove();
        shown = null;
      }
    }

    function show(id) {
      const item = Array.from(tree.querySelectorAll(".sb-item[data-id]")).find(function (n) {
        return n.dataset.id === id;
      });
      const t = dataOf(id);
      if (item == null || t == null) {
        return;
      }
      shown = card(t);
      document.body.appendChild(shown);
      const r = item.getBoundingClientRect();
      const box = tree.getBoundingClientRect();
      shown.style.left = (box.left + 8) + "px";
      shown.style.width = (box.width - 16) + "px";
      const h = shown.offsetHeight;
      const below = r.bottom + 6;
      shown.style.top = (below + h <= window.innerHeight - 6 ? below : Math.max(6, r.top - 6 - h)) + "px";
    }

    function onOver(e) {
      const item = e.target.closest != null ? e.target.closest(".sb-item[data-id]") : null;
      if (item == null) {
        hide();
        return;
      }
      const id = item.dataset.id;
      if (id === hoverId) {
        return;
      }
      hide();
      hoverId = id;
      timer = setTimeout(function () {
        show(id);
      }, DELAY_MS);
    }

    tree.addEventListener("mouseover", onOver);
    tree.addEventListener("mouseleave", hide);
    tree.addEventListener("pointerdown", hide);
    tree.addEventListener("contextmenu", hide);
    tree.addEventListener("scroll", hide);
    return { hide: hide };
  }

  return { attach: attach, data: data, card: card };
})();
