// Pinned messages per session, in kv `session:<sid>/pins`, and the `pins` pane. Keyed by a prompt's CLI uuid or an answer's message id, so the
// same pin is found from the events and from the transcript. One Pins per chat, shared by the flow and the pane through its runtime.
CC.Pins = (function () {
  const el = CC.util.el;
  const byRuntime = new WeakMap();

  function snippet(text) {
    return String(text || "").replace(/\s+/g, " ").trim().slice(0, 240);
  }

  function plain(text) {
    return String(text || "").replace(/(^|\s)#{1,6}\s+/g, "$1").replace(/[*_`]+/g, "").trim();
  }

  function key(item) {
    if (item.uuid) {
      return item.uuid;
    }
    return item.k === "text" ? String(item.id).replace(/:\d+$/, "") : item.id;
  }

  function Pins(sid, server) {
    this.sid = sid;
    this.server = server;
    this.list = [];
    this.listeners = new Set();
    this.loaded = this.load();
  }

  Pins.prototype.load = async function () {
    if (this.sid == null) {
      return;
    }
    try {
      const v = await this.server.host.kv.get("session:" + this.sid, "pins");
      // A pin made while this was on its way wins over what was stored.
      if (!this.dirty) {
        this.list = Array.isArray(v) ? v : [];
      }
    } catch (e) {
      console.warn("pins not loaded:", e && e.message);
    }
    this.emit();
  };

  Pins.prototype.on = function (fn) {
    const set = this.listeners;
    set.add(fn);
    return function () {
      set.delete(fn);
    };
  };

  Pins.prototype.emit = function () {
    this.listeners.forEach(function (fn) {
      fn();
    });
  };

  Pins.prototype.save = function () {
    this.dirty = true;
    if (this.sid != null) {
      Promise.resolve(this.server.host.kv.set("session:" + this.sid, "pins", this.list)).catch(function (e) {
        CC.ui.toast("Pins not saved: " + (e && e.message), { level: "error" });
      });
    }
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
    this.save();
    this.emit();
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
      this.list.push({ id: k, who: who, ts: item.ts || null, text: snippet(item.text), at: Date.now() });
      this.list.sort(function (a, b) {
        return (Date.parse(a.ts) || a.at) - (Date.parse(b.ts) || b.at);
      });
    }
    this.save();
    this.emit();
    return this.has(k);
  };

  // By id for a runtime-less view.
  Pins.prototype.remove = function (id) {
    this.list = this.list.filter(function (p) {
      return p.id !== id;
    });
    this.save();
    this.emit();
  };

  function of(runtime) {
    let p = byRuntime.get(runtime);
    if (p == null) {
      p = new Pins(runtime.id, CC.Servers.of(runtime));
      byRuntime.set(runtime, p);
    }
    return p;
  }

  function mountPane(host, ctx) {
    const pins = of(ctx.runtime);
    const body = el("div", "cv-pins");
    host.appendChild(body);

    function draw() {
      body.replaceChildren();
      if (pins.list.length === 0) {
        body.appendChild(el("div", "cv-empty", "Nothing pinned yet. Hover a message and click the pin to keep it here."));
        return;
      }
      pins.list.forEach(function (p) {
        const row = el("div", "cv-pin");
        const open = el("button", "cv-pin-open");
        open.type = "button";
        open.title = p.text;
        const top = el("div", "cv-pin-top");
        top.appendChild(el("span", "cv-pin-who", p.who === "user" ? "You" : "Claude"));
        if (p.ts) {
          top.appendChild(CC.conv.timeEl(p.ts));
        }
        open.append(top, el("div", "cv-pin-text", plain(p.text) || "(empty)"));
        open.addEventListener("click", function () {
          CC.Conversation.jumpTo(ctx.chatId, p.id, ctx.shell);
        });
        const remove = CC.ui.iconButton({ icon: "x", label: "Unpin", size: 14, onClick: function () {
          pins.remove(p.id);
        } });
        row.append(open, remove);
        body.appendChild(row);
      });
    }

    const off = pins.on(draw);
    draw();
    return {
      unmount: function () {
        off();
        host.replaceChildren();
      },
    };
  }

  CC.Panes.register("pins", {
    title: function () {
      return "Pinned";
    },
    mount: mountPane,
  });

  Pins.key = key;
  Pins.of = of;
  return Pins;
})();
