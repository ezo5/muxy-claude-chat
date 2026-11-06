// Messages waiting for Claude to be free, one list per chat: one delivery per idle period, a 15 s guard when the daemon never reports
// busy, Pause. Rows live in kv `session:<sid>/queue`, full images in blobs; without a blob a restored row sends its previews.
CC.ChatQueue = (function () {
  const CHUNK_CHARS = 400000;
  const PREVIEW_PREFIX = "data:image/jpeg;base64,";

  // deps: {sessionId, server, status(), canDeliver(), send(entry) → Promise}
  function Queue(deps) {
    this.deps = deps;
    this.list = [];
    this.paused = false;
    this.periodUsed = false;
    this.delivering = false;
    this.guard = null;
    this.handlers = new Set();
    this.disposed = false;
    this.loaded = this.load();
  }

  Queue.prototype.scope = function () {
    return "session:" + this.deps.sessionId;
  };

  Queue.prototype.blobId = function (rowId, index) {
    return "queue-" + this.deps.sessionId + "-" + rowId + "-" + index;
  };

  // --- contract ---

  Queue.prototype.rows = function () {
    return this.list.slice();
  };

  Queue.prototype.on = function (fn) {
    const handlers = this.handlers;
    handlers.add(fn);
    return function () {
      handlers.delete(fn);
    };
  };

  Queue.prototype.add = function (entry) {
    const row = { id: entry.id, text: entry.text, images: entry.images || [], previews: entry.previews || [], state: "queued", error: null };
    this.list.push(row);
    this.putBlobs(row);
    this.changed();
    this.tick();
    return row;
  };

  Queue.prototype.remove = function (id) {
    const row = this.find(id);
    if (row == null) {
      return null;
    }
    this.list = this.list.filter(function (x) {
      return x !== row;
    });
    this.dropBlobs(row);
    this.changed();
    return row;
  };

  Queue.prototype.pause = function (paused) {
    this.paused = paused === true;
    this.changed();
    this.tick();
  };

  // Up (-1) or down (1).
  Queue.prototype.move = function (id, delta) {
    const at = this.list.findIndex(function (x) {
      return x.id === id;
    });
    const to = at + delta;
    if (at < 0 || to < 0 || to >= this.list.length) {
      return;
    }
    const row = this.list.splice(at, 1)[0];
    this.list.splice(to, 0, row);
    this.changed();
  };

  // Send now, or retry a failed row, whatever the status.
  Queue.prototype.sendNow = function (id) {
    const row = this.find(id);
    return row != null ? this.deliver(row) : Promise.resolve();
  };

  // --- delivery ---

  // A prompt sent any other way also uses up this idle period.
  Queue.prototype.markSent = function () {
    const self = this;
    this.periodUsed = true;
    clearTimeout(this.guard);
    this.guard = setTimeout(function () {
      self.periodUsed = false;
      self.tick();
    }, Queue.GUARD_MS);
  };

  Queue.prototype.onStatus = function (status) {
    if (status === "busy") {
      clearTimeout(this.guard);
      this.periodUsed = false;
    }
    this.tick();
  };

  Queue.prototype.tick = async function () {
    if (this.disposed || this.paused || this.delivering || this.periodUsed || this.deps.status() !== "idle" || !this.deps.canDeliver()) {
      return;
    }
    const next = this.list.find(function (r) {
      return r.state === "queued";
    });
    if (next == null) {
      return;
    }
    this.delivering = true;
    try {
      await this.deliver(next);
    } finally {
      this.delivering = false;
    }
  };

  Queue.prototype.deliver = async function (row) {
    if (row.state === "sending") {
      return;
    }
    row.state = "sending";
    this.markSent();
    this.emit();
    try {
      await this.deps.send({ id: row.id, text: row.text, images: row.images, previews: row.previews, createdAt: Date.now(), queued: true });
      this.remove(row.id);
    } catch (e) {
      row.state = "failed";
      row.error = e && e.message ? e.message : String(e);
      this.changed();
    }
  };

  // --- storage ---

  Queue.prototype.find = function (id) {
    return this.list.find(function (x) {
      return x.id === id;
    }) || null;
  };

  Queue.prototype.emit = function () {
    const rows = this.rows();
    this.handlers.forEach(function (fn) {
      try {
        fn(rows);
      } catch (e) {
        console.error("queue handler failed", e);
      }
    });
  };

  Queue.prototype.changed = function () {
    this.save();
    this.emit();
  };

  Queue.prototype.save = function () {
    const rows = this.list.map(function (r) {
      return { id: r.id, text: r.text, images: (r.images || []).map(function (img) {
        return { media_type: img.media_type };
      }), previews: r.previews, state: r.state === "sending" ? "failed" : r.state, error: r.error || null };
    });
    const value = rows.length > 0 || this.paused ? { paused: this.paused, rows: rows } : null;
    const write = value != null ? this.deps.server.host.kv.set(this.scope(), "queue", value) : this.deps.server.host.kv.del(this.scope(), "queue");
    Promise.resolve(write).catch(function (e) {
      console.warn("queue not saved", e && e.message);
    });
  };

  Queue.prototype.load = async function () {
    let saved = null;
    try {
      saved = await this.deps.server.host.kv.get(this.scope(), "queue");
    } catch (e) {
      console.warn("queue not loaded", e && e.message);
    }
    if (saved == null || !Array.isArray(saved.rows)) {
      return;
    }
    const restored = [];
    for (const r of saved.rows) {
      restored.push({ id: r.id, text: r.text || "", images: await this.restoreImages(r), previews: r.previews || [],
        state: r.state === "queued" ? "queued" : "failed", error: r.error || null });
    }
    if (this.disposed) {
      return;
    }
    this.paused = saved.paused === true;
    const addedMeanwhile = this.list.length > 0;
    this.list = restored.concat(this.list);
    if (addedMeanwhile) {
      this.save();
    }
    this.emit();
    this.tick();
  };

  Queue.prototype.restoreImages = async function (row) {
    const out = [];
    const images = row.images || [];
    for (let i = 0; i < images.length; i++) {
      const data = await this.getBlob(this.blobId(row.id, i));
      const preview = (row.previews || [])[i];
      if (data != null) {
        out.push({ media_type: images[i].media_type, data: data });
      } else if (typeof preview === "string" && preview.indexOf(PREVIEW_PREFIX) === 0) {
        out.push({ media_type: "image/jpeg", data: preview.slice(PREVIEW_PREFIX.length) });
      }
    }
    return out;
  };

  Queue.prototype.putBlobs = async function (row) {
    try {
      for (let i = 0; i < row.images.length; i++) {
        const data = row.images[i].data || "";
        const total = Math.max(1, Math.ceil(data.length / CHUNK_CHARS));
        for (let c = 0; c < total; c++) {
          await this.deps.server.host.call("blobPut", { id: this.blobId(row.id, i), index: c, last: c === total - 1, chunk: data.slice(c * CHUNK_CHARS, (c + 1) * CHUNK_CHARS) });
        }
      }
    } catch (e) {
      console.warn("queued image not stored, a reload sends its preview", e && e.message);
    }
  };

  // Decoded chunk by chunk: the server's chunk ends are not on base64 boundaries.
  Queue.prototype.getBlob = async function (id) {
    try {
      let bytes = "";
      for (;;) {
        const res = await this.deps.server.host.call("blobGet", { id: id, offset: bytes.length });
        bytes += atob(res.chunk || "");
        if (res.more !== true) {
          break;
        }
      }
      return bytes !== "" ? btoa(bytes) : null;
    } catch (e) {
      return null;
    }
  };

  Queue.prototype.dropBlobs = function (row) {
    for (let i = 0; i < (row.images || []).length; i++) {
      Promise.resolve(this.deps.server.host.call("blobDel", { id: this.blobId(row.id, i) })).catch(function (e) {
        console.warn("queued image not deleted", e && e.message);
      });
    }
  };

  Queue.prototype.dispose = function () {
    this.disposed = true;
    clearTimeout(this.guard);
    this.handlers.clear();
  };

  Queue.GUARD_MS = 15000;
  return Queue;
})();
