// Draws the model's items into the tree. A row whose content didn't change keeps its element, so its spinner keeps turning and focus stays.
CC.SidebarView = (function () {
  const el = CC.util.el;
  const SPIN_MS = 1000;
  const EMPTY_TEXT = {
    none: "No chats yet. Cmd+Shift+T starts one.",
    filtered: "This view hides every chat. Change it in the view menu.",
    noTerminals: "No projects here yet.",
  };

  function middleClose(node, close) {
    node.addEventListener("mousedown", function (e) {
      if (e.button === 1) {
        e.preventDefault();
      }
    });
    node.addEventListener("auxclick", function (e) {
      if (e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    });
  }

  function tileEl(tile) {
    const t = el("span", "sb-tile", tile.letter);
    t.dataset.tone = String(tile.tone);
    t.setAttribute("aria-hidden", "true");
    return t;
  }

  // The one mark left of the title, always the same width so the title stays put. The first that applies: the spinner while it works, the
  // error mark, the unread dot, the project's tile, a terminal's icon, the quiet dot of a live chat, else the room that lines the title up under
  // its project. Needs you is the pill on the right alone, so its row shows what a row at rest would without the dot.
  function leadOf(item) {
    const row = item.row;
    const need = row.state === "need";
    const unread = row.unread === true && !item.active && !need;
    const working = row.state === "busy" || row.state === "bg";
    if (working || row.state === "error" || unread) {
      const lead = el("span", "sb-lead");
      lead.appendChild(CC.ui.stateMark(row.state, { unread: unread }));
      return lead;
    }
    if (item.tile != null) {
      return tileEl(item.tile);
    }
    if (row.kind === "terminal") {
      const m = el("span", "sb-lead sb-mark-terminal");
      m.appendChild(CC.ui.icon("terminal", 13));
      return m;
    }
    const lead = el("span", "sb-lead");
    if (row.state === "idle") {
      lead.appendChild(el("span", "sb-live"));
      lead.title = "Session running";
    }
    return lead;
  }

  // All spinners turn in step, so a redrawn row doesn't jump.
  function syncSpinners(node) {
    node.querySelectorAll(".cc-spin").forEach(function (s) {
      s.style.animationDelay = -(performance.now() % SPIN_MS) + "ms";
    });
  }

  function groupEl(item, on) {
    const head = el("div", "sb-head" + (item.collapsed ? " is-collapsed" : "") + (item.selected === true ? " is-selected" : ""));
    const toggle = el("button", "sb-head-toggle");
    toggle.type = "button";
    // A project's row selects it; only its own chevron folds it. Any other group folds from the whole row.
    const chev = el(item.project != null ? "button" : "span", "sb-chev");
    chev.appendChild(CC.ui.icon("chevron", 11));
    if (item.project != null) {
      head.classList.add("sb-project");
      toggle.appendChild(tileEl(item.tile));
      chev.type = "button";
      chev.setAttribute("aria-label", (item.collapsed ? "Expand " : "Collapse ") + item.label);
      chev.setAttribute("aria-expanded", String(!item.collapsed));
      chev.addEventListener("click", function () {
        on.toggleGroup(item.key);
      });
    } else {
      toggle.setAttribute("aria-expanded", String(!item.collapsed));
      toggle.appendChild(chev);
    }
    toggle.appendChild(el("span", "sb-head-label", item.label));
    if (item.tag != null) {
      toggle.appendChild(el("span", "sb-head-tag", item.tag));
    }
    if (item.project != null) {
      toggle.appendChild(el("span", "sb-head-fill"));
    }
    if (item.mark != null) {
      toggle.appendChild(item.mark === "unread" ? CC.ui.stateMark("idle", { unread: true }) : CC.ui.stateMark(item.mark));
    }
    if (item.count > 0 && item.project == null) {
      toggle.appendChild(el("span", "sb-head-count", String(item.count)));
    }
    toggle.addEventListener("click", function () {
      if (item.project != null) {
        on.selectProject(item.key);
      } else {
        on.toggleGroup(item.key);
      }
    });
    head.appendChild(toggle);
    if (item.project != null) {
      toggle.title = item.project.path;
      head.appendChild(chev);
      head.appendChild(CC.ui.iconButton({
        icon: "plus", size: 13, label: item.adds,
        onClick: function () {
          on.newChat(item.project);
        },
      }));
      head.addEventListener("contextmenu", function (e) {
        e.preventDefault();
        e.stopPropagation();
        on.projectMenu(item, e);
      });
    }
    if (item.drag === true) {
      head.dataset.drag = "project";
      head.dataset.id = item.project.id;
      head.dataset.scope = item.dragScope;
      toggle.dataset.dragHandle = "1";
    }
    syncSpinners(head);
    return head;
  }

  // A server's head: its icon, name and online dot; a click folds it.
  function serverEl(item, on) {
    const s = item.server;
    const head = el("div", "sb-srv" + (item.collapsed ? " is-collapsed" : ""));
    head.dataset.kind = s.kind;
    const toggle = el("button", "sb-srv-toggle");
    toggle.type = "button";
    toggle.title = s.title;
    toggle.appendChild(CC.ui.icon(s.kind === "local" ? "laptop" : "server", 14));
    toggle.appendChild(el("span", "sb-srv-name", s.name));
    toggle.setAttribute("aria-expanded", String(!item.collapsed));
    const chev = el("span", "sb-chev");
    chev.appendChild(CC.ui.icon("chevron", 11));
    toggle.appendChild(el("span", "sb-head-fill"));
    if (item.mark != null) {
      toggle.appendChild(item.mark === "unread" ? CC.ui.stateMark("idle", { unread: true }) : CC.ui.stateMark(item.mark));
    }
    toggle.appendChild(chev);
    if (s.state != null) {
      const dot = el("span", "sb-srv-dot");
      dot.dataset.state = s.state;
      dot.title = s.stateTitle;
      dot.setAttribute("aria-label", s.stateTitle);
      toggle.appendChild(dot);
    }
    toggle.addEventListener("click", function () {
      on.toggleGroup(item.key);
    });
    head.appendChild(toggle);
    head.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      e.stopPropagation();
      on.serverMenu(item, e);
    });
    syncSpinners(head);
    return head;
  }

  function kidsEl(item, on) {
    const kids = el("button", "sb-kids" + (item.kids.open ? " is-open" : ""));
    kids.type = "button";
    kids.title = item.kids.open ? "Hide agents and forks" : "Show agents and forks";
    kids.setAttribute("aria-expanded", String(item.kids.open));
    if (item.kids.agents > 0) {
      kids.appendChild(CC.ui.icon("bot", 12));
      kids.appendChild(el("span", null, String(item.kids.agents)));
    }
    kids.appendChild(CC.ui.icon("chevron", 10));
    kids.addEventListener("click", function (e) {
      e.stopPropagation();
      on.toggleKids(item.row.id, !item.kids.open);
    });
    return kids;
  }

  function rowEl(item, on, number) {
    const row = item.row;
    const terminal = row.kind === "terminal";
    const actions = [];
    if (item.allow) {
      actions.push(CC.ui.chip({
        label: "Allow once", tone: "need",
        onClick: function () {
          on.allow(row);
        },
      }));
    }
    const wrap = CC.ui.listRow({
      title: terminal ? CC.SidebarModel.terminalTitle(row.title) : row.title,
      sub: item.sub != null ? item.sub.text : null,
      subTone: item.sub != null ? item.sub.tone : null,
      mark: leadOf(item),
      strong: row.unread === true && !item.active,
      quiet: row.state === "stopped",
      active: item.active,
      actions: actions,
      onClick: function (e) {
        on.pick(row, e);
      },
    });
    wrap.classList.add("sb-item");
    wrap.dataset.id = row.id;
    if (item.depth > 0) {
      wrap.classList.add("sb-child");
      wrap.style.setProperty("--sb-depth", String(item.depth));
    }
    if (item.sub != null && item.sub.lines != null) {
      const sub = wrap.querySelector(".cc-row-sub");
      sub.classList.remove("is-one-line");
      sub.classList.add("sb-preview");
      sub.style.webkitLineClamp = String(item.sub.lines);
    }
    if (item.drag) {
      wrap.dataset.drag = "row";
      wrap.dataset.scope = item.group;
      wrap.querySelector(".cc-row").dataset.dragHandle = "1";
    }
    const end = el("span", "sb-end");
    if (number != null) {
      wrap.classList.add("has-num");
      end.appendChild(el("span", "sb-num", String(number)));
    } else {
      // The title keeps clear of this text: the end floats over the row, so its sub line can use the full width.
      const text = (item.meta != null ? item.meta.length : 0) + (item.branch != null ? item.branch.length : 0);
      if (text > 0) {
        wrap.classList.add("has-meta");
        wrap.style.setProperty("--sb-meta-ch", String(text));
      }
      if (item.meta != null) {
        end.appendChild(el("span", "sb-meta", item.meta));
      }
      if (item.branch != null) {
        const branch = el("span", "sb-branch", item.branch);
        branch.title = item.branch;
        end.appendChild(branch);
      }
      if (row.state === "need") {
        wrap.classList.add("has-pill");
        end.appendChild(el("span", "sb-pill", "Needs you"));
      }
      end.appendChild(CC.ui.iconButton({
        icon: "x", size: 12, label: terminal ? "Close this terminal" : "Close this chat",
        onClick: function (e) {
          e.stopPropagation();
          on.close(row);
        },
      }));
    }
    if (item.kids != null) {
      wrap.classList.add("has-kids");
      wrap.classList.toggle("has-agents", item.kids.agents > 0);
      end.appendChild(kidsEl(item, on));
    }
    wrap.appendChild(end);
    wrap.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      e.stopPropagation();
      on.rowMenu(row, e);
    });
    middleClose(wrap, function () {
      on.close(row);
    });
    syncSpinners(wrap);
    return wrap;
  }

  // Only running subagents get a row, so a spinner would say nothing the row doesn't.
  function agentEl(item, on) {
    const mark = el("span", "cc-mark");
    mark.appendChild(CC.ui.icon("bot", 13));
    const wrap = CC.ui.listRow({
      title: item.agent.label,
      mark: mark,
      onClick: function (e) {
        on.openAgent(item.chatId, item.agent, e);
      },
    });
    wrap.classList.add("sb-child", "sb-agent");
    wrap.style.setProperty("--sb-depth", String(item.depth));
    wrap.querySelector(".cc-row").title = item.agent.label + (item.agent.type ? " (" + item.agent.type + ")" : "") + "\nOpen its transcript";
    return wrap;
  }

  // Keeps what stays, inserts what's new, removes the rest; an unchanged tree isn't touched at all.
  function place(parent, nodes) {
    nodes.forEach(function (node, i) {
      if (parent.children[i] !== node) {
        parent.insertBefore(node, parent.children[i] || null);
      }
    });
    while (parent.children.length > nodes.length) {
      parent.lastElementChild.remove();
    }
  }

  function draw(item, on, number) {
    if (item.type === "group") {
      return groupEl(item, on);
    }
    if (item.type === "server") {
      return serverEl(item, on);
    }
    return item.type === "agent" ? agentEl(item, on) : rowEl(item, on, number);
  }

  // on: {toggleGroup, selectProject, serverMenu, newChat, projectMenu, allow, pick, close, toggleKids, rowMenu, openAgent}
  function Tree(tree, on) {
    this.tree = tree;
    this.on = on;
    this.cache = new Map();
    this.emptyEl = el("div", "sb-empty");
  }

  // numbers: {rowId: n} while Cmd+Shift is held.
  Tree.prototype.render = function (model, numbers) {
    const self = this;
    const focused = this.tree.contains(document.activeElement) ? document.activeElement.closest("[data-key]") : null;
    const focusKey = focused != null ? focused.dataset.key : null;
    const next = new Map();
    const nodes = model.items.map(function (item) {
      const number = item.type === "row" && numbers[item.row.id] != null ? numbers[item.row.id] : null;
      const sig = JSON.stringify(item) + "|" + number;
      const known = self.cache.get(item.key);
      const entry = known != null && known.sig === sig ? known : { sig: sig, el: draw(item, self.on, number) };
      entry.el.dataset.key = item.key;
      next.set(item.key, entry);
      return entry.el;
    });
    if (model.empty != null) {
      this.emptyEl.textContent = EMPTY_TEXT[model.empty];
      nodes.push(this.emptyEl);
    }
    this.cache = next;
    place(this.tree, nodes);
    if (focusKey != null && !this.tree.contains(document.activeElement)) {
      const again = Array.from(this.tree.children).find(function (n) {
        return n.dataset.key === focusKey;
      });
      const button = again != null ? again.querySelector("button") : null;
      if (button != null) {
        button.focus();
      }
    }
  };

  return { Tree: Tree };
})();
