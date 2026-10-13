window.CC = window.CC || {};

CC.Composer.use(function (composer) {
  const util = CC.util;
  const el = util.el;
  const box = el("div", "popup hidden");
  composer.popupHost.appendChild(box);
  let items = [];
  let index = 0;
  let current = null;

  function render() {
    box.textContent = "";
    if (current.title) {
      box.appendChild(el("div", "popup-title", current.title));
    }
    items.forEach(function (it, i) {
      const row = el("div", "popup-item" + (i === index ? " active" : ""));
      row.appendChild(el("span", "pi-label", it.label));
      if (it.hint) {
        row.appendChild(el("span", "pi-hint", it.hint));
      }
      if (it.desc) {
        row.appendChild(el("span", "pi-desc", it.desc));
      }
      if (it.badge) {
        row.appendChild(el("span", "pi-badge", it.badge));
      }
      row.addEventListener("mousedown", function (e) {
        e.preventDefault();
        index = i;
        pick("click");
      });
      row.addEventListener("mousemove", function () {
        if (index !== i) {
          index = i;
          highlight();
        }
      });
      box.appendChild(row);
    });
    highlight();
  }

  function highlight() {
    const rows = box.querySelectorAll(".popup-item");
    rows.forEach(function (r, i) {
      r.classList.toggle("active", i === index);
    });
    const active = rows[index];
    if (active != null) {
      active.scrollIntoView({ block: "nearest" });
    }
  }

  function pick(how) {
    const it = items[index];
    const owner = current;
    close();
    if (it != null && owner != null) {
      owner.onPick(it, how);
    }
  }

  function open(owner, list, opts) {
    const o = opts || {};
    if (list.length === 0) {
      if (current === owner) {
        close();
      }
      return;
    }
    current = owner;
    current.title = o.title || null;
    items = list;
    index = Math.min(o.keepIndex ? index : 0, list.length - 1);
    box.classList.remove("hidden");
    render();
  }

  function close() {
    current = null;
    items = [];
    box.classList.add("hidden");
  }

  composer.popup = {
    open: open,
    close: close,
    isOpen: function (owner) {
      return current != null && (owner == null || current === owner);
    },
  };

  composer.on("keydown", function (e) {
    if (current == null) {
      return false;
    }
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      index = (index + 1) % items.length;
      highlight();
      return true;
    }
    if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      index = (index - 1 + items.length) % items.length;
      highlight();
      return true;
    }
    if (e.key === "Tab" && !e.shiftKey) {
      pick("tab");
      return true;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      pick("enter");
      return true;
    }
    if (e.key === "Escape") {
      close();
      return true;
    }
    return false;
  });

  composer.input.addEventListener("blur", function () {
    setTimeout(function () {
      if (document.activeElement !== composer.input) {
        close();
      }
    }, 150);
  });
});
