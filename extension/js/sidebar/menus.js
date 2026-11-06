// The view menu on the header: a small floating list that stays open while you change things, with its submenus in place. Context menus use CC.ui.menu.
CC.SidebarMenus = (function () {
  const el = CC.util.el;
  CC.icons.sliders = '<path d="M4 6h10"/><path d="M18 6h2"/><circle cx="16" cy="6" r="2"/><path d="M4 12h2"/><path d="M10 12h10"/><circle cx="8" cy="12" r="2"/><path d="M4 18h8"/><path d="M16 18h4"/><circle cx="14" cy="18" r="2"/>';

  // items(): [{separator} | {label, value, check, sub: () → {title, items}, run, closes}], read again after every change.
  function panel(anchor, items) {
    const root = el("div", "cc-layer");
    const previous = document.activeElement;
    const list = el("div", "cc-menu cc-floating sb-view-menu");
    list.setAttribute("role", "menu");
    let level = null;
    anchor.classList.add("is-menu-open");

    function close() {
      root.remove();
      anchor.classList.remove("is-menu-open");
      if (previous != null && previous.focus != null) {
        previous.focus();
      }
    }

    function focusAt(index) {
      const all = list.querySelectorAll(".cc-menu-item");
      if (all.length > 0) {
        all[Math.min(index, all.length - 1)].focus();
      }
    }

    function goBack(index) {
      level = null;
      draw();
      focusAt(index || 0);
    }

    function itemEl(item, index) {
      const row = el("button", "cc-menu-item sb-view-item");
      row.type = "button";
      row.setAttribute("role", "menuitem");
      const tick = el("span", "sb-view-tick");
      if (item.check === true) {
        tick.appendChild(CC.ui.icon("check", 13));
      }
      row.appendChild(tick);
      row.appendChild(el("span", "sb-view-label", item.label));
      if (item.value != null) {
        row.appendChild(el("span", "sb-view-value", item.value));
      }
      if (item.sub != null) {
        const chev = el("span", "sb-view-chev");
        chev.appendChild(CC.ui.icon("chevron", 12));
        row.appendChild(chev);
      }
      row.addEventListener("click", function () {
        if (item.sub != null) {
          level = item.sub;
          draw();
          focusAt(1);
          return;
        }
        item.run();
        if (item.closes === true) {
          close();
        } else if (level != null) {
          goBack();
        } else {
          draw();
          focusAt(index);
        }
      });
      return row;
    }

    function draw() {
      list.replaceChildren();
      if (level != null) {
        const sub = level();
        const back = el("button", "cc-menu-item sb-view-back");
        back.type = "button";
        back.appendChild(CC.ui.icon("chevron", 12));
        back.appendChild(el("span", null, sub.title));
        back.addEventListener("click", function () {
          goBack();
        });
        list.appendChild(back);
        sub.items.forEach(function (item) {
          list.appendChild(itemEl(item, 0));
        });
        return;
      }
      let index = 0;
      items().forEach(function (item) {
        if (item.separator === true) {
          list.appendChild(el("div", "cc-menu-separator"));
        } else {
          list.appendChild(itemEl(item, index));
          index += 1;
        }
      });
    }

    function onKey(e) {
      e.stopPropagation();
      const all = Array.from(list.querySelectorAll(".cc-menu-item"));
      const at = all.indexOf(document.activeElement);
      if (e.key === "Escape") {
        e.preventDefault();
        if (level != null) {
          goBack();
        } else {
          close();
        }
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        all[(at + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length].focus();
      } else if (e.key === "ArrowLeft" && level != null) {
        e.preventDefault();
        goBack();
      }
    }

    root.addEventListener("pointerdown", function (e) {
      if (e.target === root) {
        close();
      }
    });
    list.addEventListener("keydown", onKey);
    root.appendChild(list);
    document.body.appendChild(root);
    draw();
    const box = anchor.getBoundingClientRect();
    // The gear can sit at the window's edge, with the list over the whole pane.
    list.style.left = Math.max(4, Math.min(box.left, window.innerWidth - list.offsetWidth - 4)) + "px";
    list.style.top = (box.bottom + 4) + "px";
    focusAt(0);
    return close;
  }

  return { panel: panel };
})();
