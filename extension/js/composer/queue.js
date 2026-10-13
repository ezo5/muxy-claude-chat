window.CC = window.CC || {};

CC.Composer.use(function (composer) {
  const util = CC.util;
  const el = util.el;
  const key = "queue:" + CC.host.viewId();
  let rows = [];
  let paused = false;
  let windowUsed = false;
  let usedAt = 0;
  let delivering = false;

  const box = el("div", "queue hidden");
  composer.above.appendChild(box);

  // muxy.storage caps a value at 1 MiB and the extension at 5 MiB: full images go to IndexedDB; without it a row
  // restored after a reload sends its 480 px previews.
  const blobs = (function () {
    let opened = null;

    function db() {
      if (opened == null) {
        opened = new Promise(function (resolve) {
          setTimeout(function () {
            resolve(null);
          }, 3000);
          try {
            const req = indexedDB.open("claude-chat-queue", 1);
            req.onupgradeneeded = function () {
              req.result.createObjectStore("images");
            };
            req.onsuccess = function () {
              resolve(req.result);
            };
            req.onerror = function () {
              resolve(null);
            };
          } catch (e) {
            resolve(null);
          }
        });
      }
      return opened;
    }

    async function run(mode, fn) {
      const d = await db();
      if (d == null) {
        return null;
      }
      return new Promise(function (resolve) {
        try {
          const tx = d.transaction("images", mode);
          const req = fn(tx.objectStore("images"));
          tx.oncomplete = function () {
            resolve(req.result || null);
          };
          tx.onerror = function () {
            resolve(null);
          };
          tx.onabort = tx.onerror;
        } catch (e) {
          resolve(null);
        }
      });
    }

    return {
      put: function (id, images) {
        return run("readwrite", function (s) {
          return s.put(images, key + ":" + id);
        });
      },
      get: function (id) {
        return run("readonly", function (s) {
          return s.get(key + ":" + id);
        });
      },
      drop: function (id) {
        return run("readwrite", function (s) {
          return s.delete(key + ":" + id);
        });
      },
    };
  })();

  function save() {
    CC.host.storageSet(key, rows.map(function (r) {
      return { id: r.id, text: r.text, images: (r.images || []).map(function (img) {
        return { media_type: img.media_type };
      }), previews: r.previews, state: r.state === "sending" ? "failed" : r.state, error: r.error || null };
    }));
  }

  function restoreImages(images, previews) {
    const out = [];
    (images || []).forEach(function (img, i) {
      const p = (previews || [])[i];
      if (img.data) {
        out.push(img);
      } else if (typeof p === "string" && p.indexOf("data:image/jpeg;base64,") === 0) {
        out.push({ media_type: "image/jpeg", data: p.slice("data:image/jpeg;base64,".length) });
      }
    });
    return out;
  }

  function render() {
    box.textContent = "";
    box.classList.toggle("hidden", rows.length === 0);
    if (rows.length === 0) {
      return;
    }
    const head = el("div", "queue-head");
    head.appendChild(util.icon("clock"));
    head.appendChild(el("span", "queue-title", rows.length === 1 ? "1 message waiting" : rows.length + " messages waiting"));
    const sub = el("span", "queue-sub", paused ? "paused" : "sent one by one when Claude is free");
    head.appendChild(sub);
    const pauseBtn = el("button", "chip-btn", paused ? "Resume" : "Pause");
    pauseBtn.addEventListener("click", function () {
      paused = !paused;
      render();
    });
    head.appendChild(pauseBtn);
    box.appendChild(head);
    rows.forEach(function (r, i) {
      const row = el("div", "queue-row " + r.state);
      row.appendChild(el("span", "queue-num", String(i + 1)));
      const text = el("span", "queue-text", util.firstLine(r.text, 200) || "(image only)");
      text.title = r.text;
      row.appendChild(text);
      if (r.images != null && r.images.length > 0) {
        row.appendChild(CC.images.local(r.previews, r.images.length, "queue-thumbs"));
      }
      if (r.state === "sending") {
        row.appendChild(el("span", "queue-badge", "sending…"));
      }
      if (r.state === "failed") {
        const b = el("span", "queue-badge err", "not sent");
        b.title = r.error || "";
        row.appendChild(b);
      }
      const actions = el("span", "queue-actions");
      if (i > 0) {
        actions.appendChild(action("up", "Move up", function () {
          rows.splice(i, 1);
          rows.splice(i - 1, 0, r);
          save();
          render();
        }));
      }
      actions.appendChild(action("play", r.state === "failed" ? "Retry now" : "Send now", function () {
        deliver(r);
      }));
      actions.appendChild(action("edit", "Edit (back to composer)", function () {
        remove(r);
        const cur = composer.value();
        composer.setValue(cur.trim() === "" ? r.text : r.text + "\n" + cur);
        if (composer.restoreImages != null) {
          composer.restoreImages(r.images, r.previews);
        }
        composer.focus();
      }));
      actions.appendChild(action("trash", "Remove", function () {
        remove(r);
      }));
      row.appendChild(actions);
      box.appendChild(row);
    });
  }

  function action(iconName, title, fn) {
    const b = el("button", "icon-btn");
    b.type = "button";
    b.title = title;
    b.appendChild(util.icon(iconName));
    b.addEventListener("click", function (e) {
      e.preventDefault();
      fn();
    });
    return b;
  }

  function remove(r) {
    rows = rows.filter(function (x) {
      return x !== r;
    });
    if (r.images != null && r.images.length > 0) {
      blobs.drop(r.id);
    }
    save();
    render();
  }

  function add(entry) {
    rows.push({ id: entry.id, text: entry.text, images: entry.images || [], previews: entry.previews || [], state: "queued" });
    if (entry.images != null && entry.images.length > 0) {
      blobs.put(entry.id, entry.images);
    }
    save();
    render();
  }

  async function deliver(r) {
    if (r.state === "sending") {
      return;
    }
    r.state = "sending";
    windowUsed = true;
    usedAt = Date.now();
    render();
    try {
      await composer.deps.send({ id: r.id, text: r.text, images: r.images, previews: r.previews, createdAt: Date.now(), queued: true });
      remove(r);
    } catch (e) {
      r.state = "failed";
      r.error = e && e.message ? e.message : String(e);
      save();
      render();
    }
  }

  // One delivery per idle window: the daemon reports busy within ~200 ms of accepting a prompt.
  async function tick() {
    if (composer.status !== "idle") {
      return;
    }
    if (windowUsed && Date.now() - usedAt > 15000) {
      windowUsed = false;
    }
    const next = rows.find(function (r) {
      return r.state === "queued";
    });
    if (paused || delivering || windowUsed || next == null) {
      return;
    }
    delivering = true;
    try {
      await deliver(next);
    } finally {
      delivering = false;
    }
  }

  composer.on("enqueue", function (entry) {
    add(entry);
    return true;
  });

  composer.on("status", function (s) {
    if (s.status === "busy") {
      windowUsed = false;
    }
    return false;
  });

  composer.on("keydown", function (e) {
    if (e.key === "Tab" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && composer.value().trim() !== "") {
      const entry = composer.collect();
      if (entry.blocked) {
        return true;
      }
      composer.emit("submitted", entry);
      composer.setValue("");
      add(entry);
      return true;
    }
    if (e.key === "ArrowUp" && e.altKey && rows.length > 0 && composer.value().trim() === "") {
      const r = rows[rows.length - 1];
      remove(r);
      composer.setValue(r.text);
      if (composer.restoreImages != null) {
        composer.restoreImages(r.images, r.previews);
      }
      return true;
    }
    return false;
  });

  composer.markSent = function () {
    windowUsed = true;
    usedAt = Date.now();
  };

  CC.host.storageGet(key).then(async function (saved) {
    if (!Array.isArray(saved)) {
      return;
    }
    const restored = [];
    for (const r of saved) {
      const kept = r.images != null && r.images.length > 0 ? await blobs.get(r.id) : null;
      const images = Array.isArray(kept) && kept.length === r.images.length ? kept : restoreImages(r.images, r.previews);
      restored.push({ id: r.id, text: r.text || "", images: images, previews: r.previews || [], state: r.state === "queued" ? "queued" : "failed", error: r.error });
    }
    rows = restored.concat(rows);
    render();
  });

  setInterval(tick, 400);
  render();
});
