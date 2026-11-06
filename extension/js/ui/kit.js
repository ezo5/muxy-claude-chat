// The UI kit. Every factory returns a DOM element ready to append and keeps no state outside it, so two panes never share any.
// Controls that change later have methods on the element: disclosure and card setOpen / isOpen, ring set.
CC.ui = (function () {
  const el = CC.util.el;
  const NS = "http://www.w3.org/2000/svg";

  function icon(name, size) {
    const s = size || 16;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", s);
    svg.setAttribute("height", s);
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "cc-svg");
    svg.innerHTML = CC.icons[name] || "";
    return svg;
  }

  function button(opts) {
    const b = el("button", "cc-btn" + (opts.primary ? " cc-btn-primary" : ""), opts.label);
    b.type = "button";
    if (opts.onClick != null) {
      b.addEventListener("click", opts.onClick);
    }
    return b;
  }

  // Square, label only as tooltip and for screen readers.
  function iconButton(opts) {
    // The gear is the one settings control: same icon, size, hover and open state wherever it stands, so it takes no size.
    const gear = opts.icon === "gear";
    const b = el("button", "cc-icon-btn" + (gear ? " cc-settings-btn" : "") + (opts.on ? " is-on" : ""));
    b.type = "button";
    b.title = opts.label;
    b.setAttribute("aria-label", opts.label);
    b.appendChild(icon(opts.icon, gear ? null : opts.size));
    if (opts.onClick != null) {
      b.addEventListener("click", opts.onClick);
    }
    return b;
  }

  function chip(opts) {
    const interactive = opts.onClick != null;
    const c = el(interactive ? "button" : "span", "cc-chip" + (opts.tone ? " cc-tone-" + opts.tone : ""), opts.label);
    if (interactive) {
      c.type = "button";
      c.addEventListener("click", function (e) {
        e.stopPropagation();
        opts.onClick(e);
      });
    }
    return c;
  }

  // "+31 −11", in diff colours.
  function numbers(add, del) {
    const n = el("span", "cc-num");
    n.appendChild(el("span", "cc-add", "+" + add));
    n.appendChild(document.createTextNode(" "));
    n.appendChild(el("span", "cc-del", "−" + del));
    return n;
  }

  function fill(host, body) {
    if (typeof body === "function") {
      body(host);
    } else if (body != null) {
      host.appendChild(body);
    }
  }

  function chevron() {
    const c = el("span", "cc-chev");
    c.appendChild(icon("chevron", 12));
    return c;
  }

  // Grey summary line, detail in place. `body` is a node or fn(el), built on first open.
  function disclosure(opts) {
    const root = el("div", "cc-disclosure");
    const head = el("button", "cc-disclosure-line");
    head.type = "button";
    head.appendChild(el("span", "cc-disclosure-label", opts.label));
    if (opts.numbers != null) {
      head.appendChild(numbers(opts.numbers[0], opts.numbers[1]));
    }
    head.appendChild(chevron());
    root.appendChild(head);
    let bodyEl = null;

    function setOpen(open) {
      root.classList.toggle("is-open", open);
      head.setAttribute("aria-expanded", String(open));
      if (open && bodyEl == null) {
        bodyEl = el("div", "cc-disclosure-body");
        fill(bodyEl, opts.body);
        root.appendChild(bodyEl);
      }
      if (bodyEl != null) {
        bodyEl.hidden = !open;
      }
    }

    head.addEventListener("click", function () {
      const open = !root.classList.contains("is-open");
      setOpen(open);
      if (opts.onToggle != null) {
        opts.onToggle(open);
      }
    });
    root.setOpen = setOpen;
    root.isOpen = function () {
      return root.classList.contains("is-open");
    };
    setOpen(opts.open === true);
    return root;
  }

  // A row of the sidebar or any list: mark, title, optional sub line, optional actions under it.
  // title, sub, subTone: "need", quiet, strong (unread), active, onClick, mark: node, actions: [node], menu: fn → items
  function listRow(opts) {
    const wrap = el("div", "cc-row-wrap");
    const row = el("button", "cc-row" + (opts.active ? " is-active" : ""));
    row.type = "button";
    row.appendChild(opts.mark || el("span", "cc-mark"));
    const body = el("span", "cc-row-body");
    const titleCls = "cc-row-title" + (opts.strong ? " is-strong" : "") + (opts.quiet ? " is-quiet" : "");
    body.appendChild(el("span", titleCls, opts.title));
    if (opts.sub != null) {
      const tone = opts.subTone === "need" ? " is-need" : " is-one-line";
      body.appendChild(el("span", "cc-row-sub" + tone, opts.sub));
    }
    row.appendChild(body);
    if (opts.onClick != null) {
      row.addEventListener("click", opts.onClick);
    }
    wrap.appendChild(row);
    if (opts.actions != null && opts.actions.length > 0) {
      const actions = el("div", "cc-row-actions");
      opts.actions.forEach(function (a) {
        actions.appendChild(a);
      });
      wrap.appendChild(actions);
    }
    return wrap;
  }

  // The one header bar of a column: sidebar, every pane, rail. Same height, title and separator everywhere; the owner only says what's in it.
  // opts and set(): {title, lead: [node], actions: [node]}. opts.cls and opts.titleCls add the owner's own hooks.
  function bar(opts) {
    const root = el("header", "cc-bar" + (opts.cls != null ? " " + opts.cls : ""));
    root.set = function (o) {
      const title = el("span", "cc-bar-title" + (opts.titleCls != null ? " " + opts.titleCls : ""), o.title);
      title.title = o.title;
      root.replaceChildren.apply(root, (o.lead || []).concat([title], o.actions || []));
    };
    root.set(opts);
    return root;
  }

  // A collapsible section, the rail's card. `status` shows when collapsed; a string, a node, or fn → either. `icon` goes before the title.
  function card(opts) {
    const root = el("section", "cc-card");
    const head = el("button", "cc-card-head");
    head.type = "button";
    if (opts.icon != null) {
      const mark = el("span", "cc-card-icon");
      mark.appendChild(icon(opts.icon, 14));
      head.appendChild(mark);
    }
    head.appendChild(el("span", "cc-card-title", opts.title));
    const status = el("span", "cc-card-status");
    head.appendChild(status);
    head.appendChild(chevron());
    const bodyEl = el("div", "cc-card-body");
    root.appendChild(head);
    root.appendChild(bodyEl);
    let filled = false;

    function setOpen(open) {
      root.classList.toggle("is-open", open);
      head.setAttribute("aria-expanded", String(open));
      bodyEl.hidden = !open;
      root.refreshStatus();
      if (open && !filled) {
        filled = true;
        fill(bodyEl, opts.body);
      }
    }

    root.refreshStatus = function () {
      const value = typeof opts.status === "function" ? opts.status() : opts.status;
      status.replaceChildren();
      if (!root.classList.contains("is-open") && value != null) {
        status.append(value);
      }
    };
    root.setOpen = setOpen;
    root.isOpen = function () {
      return root.classList.contains("is-open");
    };
    head.addEventListener("click", function () {
      const open = !root.isOpen();
      setOpen(open);
      if (opts.onToggle != null) {
        opts.onToggle(open);
      }
    });
    setOpen(opts.open !== false);
    return root;
  }

  // Context used. Colour stays neutral: a ring is information, not an alarm.
  function ring(pct) {
    const r = 5.5;
    const len = 2 * Math.PI * r;
    const root = el("span", "cc-ring");
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("viewBox", "0 0 14 14");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = '<circle class="cc-ring-track" cx="7" cy="7" r="' + r + '"/><circle class="cc-ring-value" cx="7" cy="7" r="' + r + '" transform="rotate(-90 7 7)"/>';
    const label = el("span", "cc-ring-label");
    root.appendChild(svg);
    root.appendChild(label);
    root.set = function (value) {
      const v = Math.max(0, Math.min(100, Math.round(value)));
      svg.querySelector(".cc-ring-value").setAttribute("stroke-dasharray", (len * v / 100) + " " + len);
      label.textContent = v + "%";
    };
    root.set(pct);
    return root;
  }

  // The one working spinner. It keeps turning under reduced motion: it's the only sign of work.
  function spinner(opts) {
    return el("span", "cc-spin" + (opts != null && opts.quiet === true ? " cc-spin-quiet" : ""));
  }

  // need = amber triangle, busy = accent spinner, bg = quiet spinner, error = red, unread = accent dot, rest = empty but same width.
  function stateMark(state, opts) {
    const mark = el("span", "cc-mark");
    if (state === "need") {
      mark.classList.add("cc-mark-need");
      mark.appendChild(icon("needs", 12));
    } else if (state === "busy") {
      mark.appendChild(spinner());
    } else if (state === "bg") {
      mark.appendChild(spinner({ quiet: true }));
    } else if (state === "error") {
      mark.classList.add("cc-mark-error");
      mark.appendChild(icon("alert", 12));
    } else if (opts != null && opts.unread === true) {
      mark.appendChild(el("span", "cc-dot"));
    }
    return mark;
  }

  // Floating things live on the body, outside any pane. Anything that closes them is theirs, not a document listener.
  function layer() {
    const root = el("div", "cc-layer");
    document.body.appendChild(root);
    return root;
  }

  function menuKeys(e, list, close) {
    e.stopPropagation();
    const items = Array.from(list.querySelectorAll(".cc-menu-item:not([disabled])"));
    const at = items.indexOf(document.activeElement);
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      items[(at + step + items.length) % items.length].focus();
    }
  }

  // items: [{label, icon, run, disabled, danger} | {separator: true}]. opts.at: {x, y} or opts.anchor: element. Returns a closer.
  function menu(items, opts) {
    const root = layer();
    const previous = document.activeElement;
    const list = el("div", "cc-menu cc-floating");
    list.setAttribute("role", "menu");

    const anchor = opts != null ? opts.anchor : null;
    if (anchor != null) {
      anchor.classList.add("is-menu-open");
    }

    function close() {
      root.remove();
      if (anchor != null) {
        anchor.classList.remove("is-menu-open");
      }
      if (previous != null && previous.focus != null) {
        previous.focus();
      }
    }

    items.forEach(function (item) {
      if (item.separator === true) {
        list.appendChild(el("div", "cc-menu-separator"));
        return;
      }
      const row = el("button", "cc-menu-item" + (item.danger ? " is-danger" : ""));
      row.type = "button";
      row.setAttribute("role", "menuitem");
      row.disabled = item.disabled === true;
      if (item.icon != null) {
        row.appendChild(icon(item.icon, 14));
      }
      row.appendChild(el("span", null, item.label));
      row.addEventListener("click", function () {
        close();
        item.run();
      });
      list.appendChild(row);
    });
    root.addEventListener("pointerdown", function (e) {
      if (e.target === root) {
        close();
      }
    });
    list.addEventListener("keydown", function (e) {
      menuKeys(e, list, close);
    });
    root.appendChild(list);
    let x = 0;
    let y = 0;
    if (opts != null && opts.at != null) {
      x = opts.at.x;
      y = opts.at.y;
    } else if (opts != null && opts.anchor != null) {
      const box = opts.anchor.getBoundingClientRect();
      x = box.left;
      y = box.bottom + 4;
    }
    const size = list.getBoundingClientRect();
    list.style.left = Math.max(4, Math.min(x, window.innerWidth - size.width - 4)) + "px";
    list.style.top = Math.max(4, Math.min(y, window.innerHeight - size.height - 4)) + "px";
    const first = list.querySelector(".cc-menu-item:not([disabled])");
    if (first != null) {
      first.focus();
    }
    return close;
  }

  // opts: {title, text, body: node, buttons: [{label, primary, value}]}. Resolves to the clicked value, or null on Esc.
  function dialog(opts) {
    return new Promise(function (resolve) {
      const root = layer();
      root.classList.add("cc-layer-dim");
      const previous = document.activeElement;
      const box = el("div", "cc-dialog cc-floating");
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");

      function done(value) {
        root.remove();
        if (previous != null && previous.focus != null) {
          previous.focus();
        }
        resolve(value);
      }

      if (opts.title != null) {
        box.appendChild(el("h2", "cc-dialog-title", opts.title));
      }
      if (opts.text != null) {
        box.appendChild(el("p", "cc-dialog-text", opts.text));
      }
      if (opts.body != null) {
        box.appendChild(opts.body);
      }
      const row = el("div", "cc-dialog-buttons");
      (opts.buttons || [{ label: "OK", primary: true, value: true }]).forEach(function (b) {
        row.appendChild(button({
          label: b.label,
          primary: b.primary,
          onClick: function () {
            done(b.value !== undefined ? b.value : b.label);
          },
        }));
      });
      box.appendChild(row);
      box.addEventListener("keydown", function (e) {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          done(null);
        }
      });
      root.appendChild(box);
      const primary = box.querySelector(".cc-btn-primary") || box.querySelector("button");
      primary.focus();
    });
  }

  let toasts = null;

  // level: "info" or "error". Errors stay longer, and are in the page because Muxy webviews have no devtools.
  function toast(text, opts) {
    if (toasts == null || !toasts.isConnected) {
      toasts = el("div", "cc-toasts");
      document.body.appendChild(toasts);
    }
    const error = opts != null && opts.level === "error";
    const t = el("div", "cc-toast cc-floating" + (error ? " is-error" : ""), text);
    t.setAttribute("role", "status");
    toasts.appendChild(t);
    setTimeout(function () {
      t.remove();
    }, error ? 8000 : 3000);
    return t;
  }

  return {
    icon: icon, button: button, iconButton: iconButton, chip: chip, numbers: numbers, disclosure: disclosure, listRow: listRow, bar: bar, card: card,
    ring: ring, spinner: spinner, stateMark: stateMark, menu: menu, dialog: dialog, toast: toast,
  };
})();
