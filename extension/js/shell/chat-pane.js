// The `chat` pane: a fixed frame the packages fill. A slot takes several factories, each in its own element; `order` places them,
// and a `fallback` (sample content) shows only while the slot has no real factory.
CC.ChatPane = (function () {
  const NAMES = ["flow", "flowEnd", "aboveComposer", "composer", "belowComposer", "overlay"];
  const factories = new Map(NAMES.map(function (n) {
    return [n, []];
  }));
  const live = new Set();

  function chosen(name) {
    const all = factories.get(name);
    const real = all.filter(function (f) {
      return f.fallback !== true;
    });
    const list = real.length > 0 ? real : all;
    return list.slice().sort(function (a, b) {
      return a.order - b.order;
    });
  }

  function unmountSlot(frame, name) {
    frame.mounted[name].forEach(function (h) {
      if (h != null && h.unmount != null) {
        h.unmount();
      }
    });
    frame.mounted[name] = [];
    frame.slots[name].replaceChildren();
  }

  function mountSlot(frame, name) {
    unmountSlot(frame, name);
    chosen(name).forEach(function (f) {
      const item = CC.util.el("div", "cc-slot-item");
      frame.slots[name].appendChild(item);
      try {
        frame.mounted[name].push(f.factory(item, frame.ctx) || null);
      } catch (e) {
        console.error("slot " + name, e);
        item.textContent = "This part couldn't load: " + e.message;
      }
    });
  }

  function slot(name, factory, opts) {
    if (!factories.has(name)) {
      throw new Error("no chat slot named " + name);
    }
    const o = opts || {};
    factories.get(name).push({ factory: factory, fallback: o.fallback === true, order: o.order || 0 });
    live.forEach(function (frame) {
      mountSlot(frame, name);
    });
  }

  function slotEl(name) {
    const s = CC.util.el("div", "cc-slot cc-slot-" + name);
    s.dataset.ccSlot = name;
    return s;
  }

  function mount(el, ctx) {
    const slots = {};
    NAMES.forEach(function (n) {
      slots[n] = slotEl(n);
    });
    const frame = { ctx: ctx, slots: slots, mounted: {} };
    NAMES.forEach(function (n) {
      frame.mounted[n] = [];
    });

    const root = CC.util.el("div", "cc-chat");
    const scroll = CC.util.el("div", "cc-chat-scroll");
    const flow = CC.util.el("div", "cc-chat-column");
    flow.appendChild(slots.flow);
    flow.appendChild(slots.flowEnd);
    scroll.appendChild(flow);
    const bottom = CC.util.el("div", "cc-chat-column cc-chat-bottom");
    bottom.appendChild(slots.aboveComposer);
    bottom.appendChild(slots.composer);
    bottom.appendChild(slots.belowComposer);
    root.appendChild(scroll);
    root.appendChild(bottom);
    root.appendChild(slots.overlay);
    el.appendChild(root);

    live.add(frame);
    NAMES.forEach(function (n) {
      mountSlot(frame, n);
    });
    const offChats = CC.Chats != null ? CC.Chats.on(ctx.setTitle) : null;

    return {
      unmount: function () {
        live.delete(frame);
        if (offChats != null) {
          offChats();
        }
        NAMES.forEach(function (n) {
          unmountSlot(frame, n);
        });
      },
      focus: function () {
        const field = slots.composer.querySelector("textarea, input, [contenteditable]");
        if (field != null) {
          field.focus();
        }
      },
    };
  }

  CC.Panes.register("chat", {
    title: function (ctx) {
      const row = CC.Chats != null ? CC.Chats.get(ctx.chatId) : null;
      return row != null ? row.title : "Chat";
    },
    mount: mount,
  });

  return { slot: slot, NAMES: NAMES };
})();
