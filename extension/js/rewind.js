window.CC = window.CC || {};

// Rewind / edit of a user message in chat mode: rewind_conversation drops the message and everything after it in the
// running CLI, rewind_files restores the files Claude touched since (file checkpoints). Only while the session is idle.
CC.Rewind = (function () {
  const util = CC.util;
  const el = util.el;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  function Rewind(opts) {
    this.opts = opts;
    this.running = false;
    this.box = el("div", "rewind-pop hidden");
    this.box.tabIndex = -1;
    document.body.appendChild(this.box);
    this.choices = [];
    this.active = 0;
    const self = this;
    document.addEventListener("mousedown", function (e) {
      if (!self.box.classList.contains("hidden") && !self.box.contains(e.target)) {
        self.close();
      }
    });
    this.box.addEventListener("keydown", function (e) {
      self.onKey(e);
    });
  }

  // The CLI's uuid of a user message: from the daemon's accepted event, or the transcript entry id of history items.
  Rewind.prototype.target = function (item) {
    if (item.k !== "user" || item.command === true || item.agent != null) {
      return null;
    }
    if (item.uuid) {
      return item.uuid;
    }
    return item.queued !== true && UUID.test(String(item.id)) ? item.id : null;
  };

  Rewind.prototype.ready = function () {
    if (this.running) {
      util.toast("A rewind is already running");
      return false;
    }
    if (this.opts.status() !== "idle") {
      util.toast("Rewind works while Claude is idle — interrupt or wait for the turn to end");
      return false;
    }
    return true;
  };

  Rewind.prototype.control = async function (subtype, payload) {
    const res = await this.opts.control(subtype, payload);
    if (res == null || res.subtype !== "success") {
      throw new Error((res && res.error) || subtype + " failed");
    }
    return res.response || {};
  };

  Rewind.prototype.open = function (item, anchor) {
    const uuid = this.target(item);
    if (uuid == null || !this.ready()) {
      return;
    }
    const self = this;
    this.box.textContent = "";
    this.box.appendChild(el("div", "rewind-title", "Rewind to here"));
    this.box.appendChild(el("div", "rewind-sub", "Claude forgets this message and everything after it."));
    const list = el("div", "rewind-list");
    this.box.appendChild(list);
    const files = el("div", "rewind-files", "Checking files…");
    this.box.appendChild(files);
    this.choices = [
      { label: "Conversation and code", conversation: true, code: true },
      { label: "Conversation only", conversation: true, code: false },
      { label: "Code only", conversation: false, code: true },
      { label: "Cancel" },
    ];
    this.choices.forEach(function (c, i) {
      const row = el("button", "rewind-choice");
      row.type = "button";
      row.appendChild(el("span", "rewind-key", String(i + 1)));
      row.appendChild(el("span", null, c.label));
      row.disabled = c.code === true;
      row.addEventListener("click", function () {
        self.pick(i, uuid);
      });
      row.addEventListener("mousemove", function () {
        self.highlight(i);
      });
      c.row = row;
      list.appendChild(row);
    });
    this.highlight(1);
    this.box.classList.remove("hidden");
    this.place(anchor);
    this.box.focus();
    const choices = this.choices;
    this.control("rewind_files", { user_message_id: uuid, dry_run: true }).then(function (r) {
      if (self.choices !== choices) {
        return;
      }
      const n = (r.filesChanged || []).length;
      if (r.canRewind !== true || n === 0) {
        files.textContent = r.canRewind !== true ? "Code rewind unavailable: " + (r.error || "no file checkpoints") : "No file changes to restore since this message.";
        choices.filter(function (c) {
          return c.code === true;
        }).forEach(function (c) {
          c.row.classList.add("hidden");
        });
        return;
      }
      files.textContent = "Code: " + n + (n === 1 ? " file" : " files") + " · +" + (r.insertions || 0) + " −" + (r.deletions || 0);
      files.title = r.filesChanged.join("\n");
      choices.forEach(function (c) {
        c.row.disabled = false;
      });
      self.place(anchor);
    }, function (e) {
      if (self.choices === choices) {
        files.textContent = "Code rewind unavailable: " + e.message;
      }
    });
  };

  Rewind.prototype.place = function (anchor) {
    const r = anchor.getBoundingClientRect();
    const box = this.box;
    const h = box.offsetHeight;
    const w = box.offsetWidth;
    const below = r.bottom + 6 + h <= window.innerHeight - 8;
    box.style.top = Math.max(8, below ? r.bottom + 6 : r.top - 6 - h) + "px";
    box.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + "px";
  };

  Rewind.prototype.highlight = function (i) {
    this.active = i;
    this.choices.forEach(function (c, k) {
      c.row.classList.toggle("active", k === i);
    });
  };

  Rewind.prototype.onKey = function (e) {
    const usable = this.choices.filter(function (c) {
      return !c.row.disabled && !c.row.classList.contains("hidden");
    });
    const at = usable.indexOf(this.choices[this.active]);
    if (e.key === "Escape") {
      this.close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const next = usable[(at + (e.key === "ArrowDown" ? 1 : usable.length - 1)) % usable.length];
      this.highlight(this.choices.indexOf(next));
    } else if (e.key === "Enter") {
      this.choices[this.active].row.click();
    } else if (/^[1-4]$/.test(e.key)) {
      const c = this.choices[Number(e.key) - 1];
      if (usable.indexOf(c) >= 0) {
        c.row.click();
      }
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  Rewind.prototype.close = function () {
    this.box.classList.add("hidden");
    this.choices = [];
  };

  Rewind.prototype.pick = function (i, uuid) {
    const c = this.choices[i];
    this.close();
    if (c != null && (c.conversation || c.code) && this.ready()) {
      this.run(uuid, c.conversation === true, c.code === true);
    }
  };

  Rewind.prototype.run = async function (uuid, conversation, code) {
    this.running = true;
    let restored = null;
    try {
      if (code) {
        const r = await this.control("rewind_files", { user_message_id: uuid });
        if (r.canRewind !== true) {
          throw new Error(r.error || "files could not be restored");
        }
        restored = r;
      }
      if (conversation) {
        await this.rewindConversation(uuid);
      }
      util.toast(conversation && code ? "Rewound the conversation and the code" : conversation ? "Rewound the conversation" : "Restored the code");
    } catch (e) {
      util.toast((restored != null ? "Code restored, but the conversation rewind failed: " : "Rewind failed: ") + e.message, "error");
    } finally {
      this.running = false;
    }
  };

  // last_seen_user_message_uuid: without it the CLI refuses a target that has later prompts ("stale_target").
  Rewind.prototype.lastSeen = function () {
    const items = this.opts.store.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const uuid = this.target(items[i]);
      if (uuid != null) {
        return uuid;
      }
    }
    return null;
  };

  Rewind.prototype.rewindConversation = async function (uuid) {
    const r = await this.control("rewind_conversation", { target_message_uuid: uuid, last_seen_user_message_uuid: this.lastSeen() });
    if (r.rewound !== true) {
      throw new Error(r.error || r.reason || "the conversation was not rewound");
    }
    this.opts.control("get_context_usage", { detail: "summary" }).catch(function () {});
    return r;
  };

  // Rewinds to just before the message and puts its text and images back into the composer.
  Rewind.prototype.edit = async function (item) {
    const uuid = this.target(item);
    if (uuid == null || !this.ready()) {
      return;
    }
    this.running = true;
    try {
      const images = await this.images(uuid, item.images || 0);
      const r = await this.rewindConversation(uuid);
      const text = r.prefillText != null ? r.prefillText : item.text;
      const composer = this.opts.composer();
      const cur = composer.value().trim();
      composer.setValue(text + (cur !== "" ? "\n\n" + cur : ""));
      if (images.length > 0) {
        composer.restoreImages(images, images.map(function (img) {
          return "data:" + img.media_type + ";base64," + img.data;
        }));
      }
      composer.focus();
    } catch (e) {
      util.toast("Edit failed: " + e.message, "error");
    } finally {
      this.running = false;
    }
  };

  Rewind.prototype.images = function (uuid, count) {
    const file = this.opts.file();
    const out = [];
    for (let n = 0; n < count; n++) {
      out.push(CC.images.load(file, uuid, n).then(function (src) {
        const m = /^data:([^;]+);base64,/.exec(src);
        return { media_type: m[1], data: src.slice(m[0].length) };
      }));
    }
    return Promise.all(out).catch(function (e) {
      throw new Error("images could not be read back: " + e.message);
    });
  };

  return Rewind;
})();
