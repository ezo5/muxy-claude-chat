// The view of ChatRuntime.queue, and how a prompt leaves the composer: sent, or a row there. A prompt that failed to send comes back from
// here too: runtime.sends() holds it with its error, and this instance keeps the full images until it's sent.
CC.Composer.use(function (composer) {
  const el = CC.util.el;
  const rt = composer.runtime;
  const unsent = new Map();

  const box = el("div", "cmp-queue");
  box.hidden = true;
  composer.aboveQueue.appendChild(box);

  function failedSends() {
    return rt.sends != null ? rt.sends().filter(function (r) {
      return r.error != null;
    }) : [];
  }

  function action(icon, label, fn) {
    return CC.ui.iconButton({
      icon: icon,
      label: label,
      size: 14,
      onClick: function (e) {
        e.preventDefault();
        fn();
      },
    });
  }

  function thumbs(previews) {
    const wrap = el("span", "cmp-queue-thumbs");
    (previews || []).forEach(function (src) {
      if (src != null) {
        const img = el("img");
        img.src = src;
        img.alt = "";
        wrap.appendChild(img);
      }
    });
    return wrap;
  }

  function backToField(text, images, previews) {
    const cur = composer.value();
    composer.setValue(cur.trim() === "" ? text : text + "\n" + cur);
    composer.restoreImages(images, previews);
    composer.focus();
  }

  function textEl(r) {
    const text = el("span", "cmp-queue-text", CC.util.firstLine(r.text, 200) || "Image only");
    text.title = r.text;
    return text;
  }

  function notSent(error) {
    const b = el("span", "cmp-queue-badge is-error", "Not sent");
    b.title = error || "";
    return b;
  }

  function rowEl(r, i) {
    const row = el("div", "cmp-queue-row is-" + r.state);
    row.appendChild(el("span", "cmp-queue-num", String(i + 1)));
    row.appendChild(textEl(r));
    row.appendChild(thumbs(r.previews));
    if (r.state === "sending") {
      row.appendChild(el("span", "cmp-queue-badge", "Sending"));
    }
    if (r.state === "failed") {
      row.appendChild(notSent(r.error));
    }
    const actions = el("span", "cmp-queue-actions");
    if (i > 0) {
      actions.appendChild(action("up", "Move up", function () {
        rt.queue.move(r.id, -1);
      }));
    }
    // While a card waits, sending past it would lose the prompt.
    if (!composer.cardWaits()) {
      actions.appendChild(action("play", r.state === "failed" ? "Retry now" : "Send now", function () {
        rt.queue.sendNow(r.id);
      }));
    }
    actions.appendChild(action("pencil", "Edit, back to the field", function () {
      rt.queue.remove(r.id);
      backToField(r.text, r.images, r.previews);
    }));
    actions.appendChild(action("trash", "Remove", function () {
      rt.queue.remove(r.id);
    }));
    row.appendChild(actions);
    return row;
  }

  function failedEl(r) {
    const row = el("div", "cmp-queue-row is-failed");
    row.appendChild(textEl(r));
    row.appendChild(thumbs(r.previews));
    row.appendChild(notSent(r.error));
    const actions = el("span", "cmp-queue-actions");
    actions.appendChild(action("pencil", "Edit, back to the field", function () {
      const entry = unsent.get(r.id);
      unsent.delete(r.id);
      rt.dismissSend(r.id);
      backToField(r.text, entry != null ? entry.images : [], r.previews);
    }));
    actions.appendChild(action("trash", "Remove", function () {
      unsent.delete(r.id);
      rt.dismissSend(r.id);
    }));
    row.appendChild(actions);
    return row;
  }

  function subtitle() {
    if (composer.cardWaits()) {
      return "sent after you answer";
    }
    return rt.queue.paused === true ? "paused" : "sent one by one when Claude is free";
  }

  function render() {
    const rows = rt.queue.rows();
    const failed = failedSends();
    box.textContent = "";
    box.hidden = rows.length === 0 && failed.length === 0;
    failed.forEach(function (r) {
      box.appendChild(failedEl(r));
    });
    if (rows.length === 0) {
      return;
    }
    const head = el("div", "cmp-queue-head");
    head.appendChild(CC.ui.icon("clock", 14));
    head.appendChild(el("span", "cmp-queue-title", rows.length === 1 ? "1 message waiting" : rows.length + " messages waiting"));
    head.appendChild(el("span", "cmp-queue-sub", subtitle()));
    const paused = rt.queue.paused === true;
    head.appendChild(CC.ui.chip({
      label: paused ? "Resume" : "Pause",
      onClick: function () {
        rt.queue.pause(!paused);
      },
    }));
    box.appendChild(head);
    rows.forEach(function (r, i) {
      box.appendChild(rowEl(r, i));
    });
    if (composer.revealCard != null) {
      composer.revealCard();
    }
  }

  composer.on("send", function (entry) {
    unsent.set(entry.id, entry);
    Promise.resolve(rt.send(entry)).then(function () {
      unsent.delete(entry.id);
    }).catch(function (e) {
      console.warn("send failed", e && e.message);
    });
    return true;
  });

  composer.on("enqueue", function (entry) {
    rt.queue.add(entry);
    return true;
  });

  composer.on("keydown", function (e) {
    if (e.key === "Tab" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && composer.value().trim() !== "") {
      const entry = composer.collect();
      if (entry.blocked) {
        return true;
      }
      composer.emit("submitted", entry);
      composer.setValue("");
      rt.queue.add(entry);
      return true;
    }
    if (e.key === "ArrowUp" && e.altKey && composer.value().trim() === "") {
      const rows = rt.queue.rows();
      if (rows.length === 0) {
        return false;
      }
      const r = rows[rows.length - 1];
      rt.queue.remove(r.id);
      composer.setValue(r.text);
      composer.restoreImages(r.images, r.previews);
      return true;
    }
    return false;
  });

  let waited = false;
  composer.on("pending", function () {
    if (composer.cardWaits() !== waited) {
      waited = composer.cardWaits();
      render();
    }
    return false;
  });
  composer.onDispose(rt.queue.on(render));
  composer.onDispose(rt.on("sends", render));
  render();
  // Rows are empty until the kv read is back.
  Promise.resolve(rt.queue.loaded).then(function () {
    if (!composer.disposed) {
      render();
    }
  });
});
