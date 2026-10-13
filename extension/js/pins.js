window.CC = window.CC || {};

// Pinned messages: per Claude session list in muxy.storage, shown in the left sidebar.
CC.Pins = (function () {
  const util = CC.util;
  const el = util.el;

  function snippet(text) {
    return text.replace(/\s+/g, " ").trim().slice(0, 240);
  }

  function plain(text) {
    return String(text || "").replace(/(^|\s)#{1,6}\s+/g, "$1").replace(/[*_`]+/g, "").trim();
  }

  // Same key from the events and the transcript: a prompt's CLI uuid, an answer's message id.
  function key(item) {
    if (item.uuid) {
      return item.uuid;
    }
    return item.k === "text" ? String(item.id).replace(/:\d+$/, "") : item.id;
  }

  function Pins(aside, toggleBtn, deps) {
    this.aside = aside;
    this.toggleBtn = toggleBtn;
    this.deps = deps;
    this.sid = null;
    this.list = [];
    const head = el("div", "pins-head");
    head.appendChild(el("span", "pins-title", "Pinned"));
    this.count = el("span", "pins-count");
    head.appendChild(this.count);
    this.body = el("div", "pins-list");
    aside.append(head, this.body);
    const self = this;
    toggleBtn.addEventListener("click", function () {
      self.setOpen(aside.classList.contains("hidden"), true);
    });
    CC.host.storageGet("pins:open:" + CC.host.viewId()).then(function (v) {
      self.setOpen(v === true, false);
    });
    this.render();
  }

  Pins.prototype.setOpen = function (open, remember) {
    this.aside.classList.toggle("hidden", !open);
    this.toggleBtn.classList.toggle("active", open);
    if (remember) {
      CC.host.storageSet("pins:open:" + CC.host.viewId(), open);
    }
  };

  Pins.prototype.load = async function (sid) {
    if (sid === this.sid) {
      return;
    }
    this.sid = sid;
    const v = sid != null ? await CC.host.storageGet("pins:" + sid) : null;
    if (sid !== this.sid) {
      return;
    }
    this.list = Array.isArray(v) ? v : [];
    this.render();
    this.deps.refreshMarks();
  };

  Pins.prototype.has = function (id) {
    return this.list.some(function (p) {
      return p.id === id;
    });
  };

  // Pins made before stable keys carry the item id (`inbox:<id>`, `<message id>:<n>`).
  Pins.prototype.rekey = function (item) {
    const k = key(item);
    const p = this.list.find(function (x) {
      return x.id === item.id;
    });
    if (p == null || k === item.id || this.sid == null) {
      return;
    }
    if (this.has(k)) {
      this.list = this.list.filter(function (x) {
        return x !== p;
      });
    } else {
      p.id = k;
    }
    CC.host.storageSet("pins:" + this.sid, this.list);
    this.render();
  };

  Pins.prototype.toggle = function (item, who) {
    const k = key(item);
    if (this.sid == null || k == null) {
      return false;
    }
    if (this.has(k)) {
      this.list = this.list.filter(function (p) {
        return p.id !== k;
      });
    } else {
      this.list.push({ id: k, who: who, ts: item.ts || null, text: snippet(item.text || ""), at: Date.now() });
      this.list.sort(function (a, b) {
        return (Date.parse(a.ts) || a.at) - (Date.parse(b.ts) || b.at);
      });
      if (this.list.length === 1) {
        this.setOpen(true, true);
      }
    }
    CC.host.storageSet("pins:" + this.sid, this.list);
    this.render();
    return this.has(k);
  };

  Pins.prototype.render = function () {
    const self = this;
    this.body.textContent = "";
    this.count.textContent = this.list.length > 0 ? String(this.list.length) : "";
    if (this.list.length === 0) {
      this.body.appendChild(el("div", "pins-empty", "Nothing pinned yet. Hover a message and click the pin to keep it here."));
      return;
    }
    this.list.forEach(function (p) {
      const row = el("div", "pin-item");
      const top = el("div", "pin-top");
      top.appendChild(el("span", "pin-who " + p.who, p.who === "user" ? "You" : "Claude"));
      if (p.ts) {
        top.appendChild(el("span", "pin-time", util.fmtTime(p.ts)));
      }
      const x = el("button", "pin-remove");
      x.type = "button";
      x.title = "Unpin";
      x.appendChild(util.icon("x"));
      x.addEventListener("click", function (e) {
        e.stopPropagation();
        self.toggle(p, p.who);
        self.deps.refreshMarks();
      });
      top.appendChild(x);
      row.append(top, el("div", "pin-text", plain(p.text) || "(empty)"));
      row.title = p.text;
      row.addEventListener("click", function () {
        if (window.matchMedia("(max-width: 720px)").matches) {
          self.setOpen(false, false);
        }
        self.deps.jump(p.id);
      });
      self.body.appendChild(row);
    });
  };

  Pins.key = key;
  return Pins;
})();
