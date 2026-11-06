// Review pane, comments: a click comments a line, Shift+click a range. Drafts live per checkout and go to Claude as one message.
(function () {
  const util = CC.util;
  const el = util.el;
  const D = CC.reviewDiff;
  const View = CC.Review.View;

  function lineLabel(at) {
    return at.from != null ? "Lines " + at.from.line + "–" + at.line : "Line " + at.line;
  }

  View.prototype.comments = function () {
    return this.drafts != null ? this.drafts.comments : [];
  };

  // Claude must know which checkout a label talks about when it isn't the chat's own.
  View.prototype.srcLabel = function () {
    const cwd = this.chatCwd();
    const root = this.root;
    const home = cwd == null || root == null || cwd === root || cwd.indexOf(root + "/") === 0;
    return home ? this.src.label : this.src.label + " in " + root;
  };

  View.prototype.rangeKeys = function (fromKey, toKey) {
    const a = this.order.get(fromKey);
    const b = this.order.get(toKey);
    const out = [];
    if (a == null || b == null) {
      return out;
    }
    this.order.forEach(function (i, key) {
      if (i >= Math.min(a, b) && i <= Math.max(a, b)) {
        out.push(key);
      }
    });
    return out;
  };

  // Rows covered by a range comment, or by the range being picked, get a bar on the left.
  View.prototype.markRanges = function () {
    const self = this;
    this.list.querySelectorAll(".rv-ranged").forEach(function (n) {
      n.classList.remove("rv-ranged");
    });
    const mark = function (from, to) {
      self.rangeKeys(from, to).forEach(function (key) {
        const at = self.rows.get(key);
        if (at != null) {
          at.cell.classList.add("rv-ranged");
        }
      });
    };
    this.comments().forEach(function (c) {
      if (c.from != null) {
        mark(D.anchorKey(c.src || D.WORKTREE_ID, c.path, c.from.sign, c.from.line), D.keyOf(c));
      }
    });
    if (this.picking != null) {
      mark(this.picking[0], this.picking[1]);
    }
  };

  View.prototype.bindLine = function (f, node, cell, row, side, keys) {
    const self = this;
    const key = D.anchorKey(this.src.id, f.path, cell.sign, cell.line);
    const anchor = { path: f.path, sign: cell.sign, line: cell.line, code: cell.code };
    node.addEventListener("mousedown", function (e) {
      if (e.shiftKey) {
        e.preventDefault();
      }
    });
    node.addEventListener("click", function (e) {
      if (window.getSelection().toString() !== "") {
        return;
      }
      const pick = self.pick;
      if (e.shiftKey && pick != null && pick.anchor.path === f.path && pick.key !== key) {
        const first = self.order.get(pick.key) < self.order.get(key);
        const from = first ? pick : { key: key, anchor: anchor };
        const to = first ? { key: key, anchor: anchor } : pick;
        const prev = self.threads.get(pick.key);
        if (prev != null && prev.editor != null && prev.editor.querySelector("textarea").value.trim() === "") {
          prev.editor.remove();
          prev.editor = null;
        }
        self.openEditor(to.key, Object.assign({}, to.anchor, { from: { sign: from.anchor.sign, line: from.anchor.line, code: from.anchor.code } }), from.key);
        return;
      }
      self.pick = { key: key, anchor: anchor };
      self.openEditor(key, anchor, null);
    });
    if (!this.rows.has(key)) {
      this.rows.set(key, { row: row, side: side, cell: node });
      this.order.set(key, this.seq++);
      keys.push(key);
    }
  };

  View.prototype.thread = function (key) {
    let t = this.threads.get(key);
    if (t == null) {
      const at = this.rows.get(key);
      t = { node: el("div", "rv-thread" + (at.side != null ? " side-" + at.side : "")), list: el("div", "rv-thread-list"), editor: null };
      t.node.appendChild(t.list);
      at.row.after(t.node);
      this.threads.set(key, t);
    }
    return t;
  };

  View.prototype.renderThread = function (key) {
    const self = this;
    if (!this.rows.has(key)) {
      return;
    }
    const t = this.thread(key);
    t.list.replaceChildren();
    this.comments().filter(function (c) {
      return D.keyOf(c) === key;
    }).forEach(function (c) {
      t.list.appendChild(self.commentBox(c, false));
    });
  };

  // Comments whose line isn't in this diff: written on another source, or the code moved on. They are sent all the same.
  View.prototype.isPlaced = function (c) {
    const f = this.files.find(function (x) {
      return x.path === c.path;
    });
    return f != null && this.anchorsOf(f).has(D.keyOf(c));
  };

  View.prototype.renderOrphans = function () {
    const self = this;
    const lost = this.comments().filter(function (c) {
      return !self.isPlaced(c);
    });
    this.orphans.replaceChildren();
    this.orphans.hidden = lost.length === 0;
    if (lost.length === 0) {
      return;
    }
    this.orphans.appendChild(el("div", "rv-orphans-head", "Comments on lines not in this diff (sent all the same)"));
    lost.forEach(function (c) {
      self.orphans.appendChild(self.commentBox(c, true));
    });
  };

  View.prototype.openEditor = function (key, anchor, fromKey) {
    const self = this;
    const t = this.thread(key);
    if (t.editor != null) {
      t.editor.remove();
      t.editor = null;
    }
    this.picking = fromKey != null ? [fromKey, key] : null;
    this.markRanges();
    t.editor = this.editor(null, anchor, function () {
      t.editor.remove();
      t.editor = null;
      self.picking = null;
      self.markRanges();
    });
    t.node.appendChild(t.editor);
    t.editor.querySelector("textarea").focus();
  };

  View.prototype.editor = function (c, anchor, done) {
    const self = this;
    const box = el("div", "rv-editor");
    const head = el("div", "rv-editor-head");
    const hint = el("span", "rv-hint", "Enter with Cmd or Ctrl to save, Esc to cancel");
    head.append(el("span", "rv-range-label", lineLabel(c != null ? c : anchor)), hint, CC.ui.iconButton({ icon: "x", label: "Cancel", size: 13, onClick: done }));
    const ta = el("textarea", "rv-input");
    ta.rows = 1;
    ta.placeholder = "Tell Claude what to change";
    ta.setAttribute("aria-label", "Tell Claude what to change");
    ta.value = c != null ? c.text : "";
    const fit = function () {
      ta.style.height = "auto";
      ta.style.height = ta.scrollHeight + "px";
      hint.hidden = ta.value.trim() === "";
    };
    ta.addEventListener("input", fit);
    setTimeout(fit, 0);
    const commit = function () {
      const text = ta.value.trim();
      if (text === "" && c == null) {
        done();
        return;
      }
      if (text === "") {
        self.removeComment(c);
      } else if (c != null) {
        c.text = text;
      } else {
        self.drafts.comments.push({
          id: util.uid(), src: self.src.id, srcLabel: self.srcLabel(), path: anchor.path, sign: anchor.sign, line: anchor.line, code: anchor.code,
          from: anchor.from || null, text: text,
        });
      }
      done();
      self.commentsChanged(c != null ? D.keyOf(c) : D.anchorKey(self.src.id, anchor.path, anchor.sign, anchor.line));
    };
    const field = el("div", "rv-editor-field");
    const save = CC.ui.iconButton({ icon: "commentAdd", label: c != null ? "Save" : "Add comment", size: 16, onClick: commit });
    save.classList.add("rv-save");
    field.append(ta, save);
    box.append(head, field);
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        done();
      }
    });
    box.addEventListener("click", function (e) {
      e.stopPropagation();
    });
    return box;
  };

  View.prototype.commentBox = function (c, withAnchor) {
    const self = this;
    const box = el("div", "rv-comment");
    const top = el("div", "rv-comment-top");
    if (withAnchor) {
      const other = (c.src || D.WORKTREE_ID) !== this.src.id ? (c.srcLabel || "another diff") + " · " : "";
      top.appendChild(el("span", "rv-anchor", other + c.path + ":" + D.where(c) + " " + D.quote(c.code)));
    } else {
      top.appendChild(el("span", "rv-range-label", lineLabel(c)));
    }
    top.appendChild(el("span", "rv-spacer"));
    const edit = CC.ui.iconButton({ icon: "pencil", label: "Edit", size: 14, onClick: function () {
      const ed = self.editor(c, null, function () {
        ed.replaceWith(box);
      });
      box.replaceWith(ed);
      ed.querySelector("textarea").focus();
    } });
    const del = CC.ui.iconButton({ icon: "trash", label: "Delete", size: 14, onClick: function () {
      self.removeComment(c);
      self.commentsChanged(D.keyOf(c));
    } });
    top.append(edit, del);
    box.append(top, el("div", "rv-comment-text", c.text));
    box.addEventListener("click", function (e) {
      e.stopPropagation();
    });
    return box;
  };

  View.prototype.removeComment = function (c) {
    this.drafts.comments = this.drafts.comments.filter(function (x) {
      return x.id !== c.id;
    });
  };

  View.prototype.commentsChanged = function (key) {
    this.drafts.saveComments();
    this.updateCount();
    this.updateHeadCount(D.pathOfKey(key));
    this.updateItem(D.pathOfKey(key));
    this.markRanges();
    this.renderThread(key);
    this.renderOrphans();
  };

  // Another pane on this checkout wrote: read again, then put what changed on the screen.
  View.prototype.draftsChanged = async function (msg) {
    const self = this;
    if (this.drafts == null || msg.scope !== this.drafts.scope || msg.from === this.drafts) {
      return;
    }
    await this.drafts.load().catch(function (e) {
      console.warn("review drafts not loaded:", e && e.message);
    });
    if (this.disposed) {
      return;
    }
    this.updateCount();
    this.applyViewed();
    this.threads.forEach(function (t, key) {
      self.renderThread(key);
    });
    this.comments().forEach(function (c) {
      self.renderThread(D.keyOf(c));
    });
    this.markRanges();
    this.renderOrphans();
    this.files.forEach(function (f) {
      self.updateHeadCount(f.path);
      self.updateItem(f.path);
      const entry = self.boxes.get(f.path);
      if (entry != null) {
        self.markViewed(entry);
        if (self.collapsed.has(f.path) === entry.built) {
          self.fill(entry);
        }
      }
    });
    this.renderSummary();
  };

  View.prototype.updateHeadCount = function (path) {
    const src = this.src.id;
    const n = this.comments().filter(function (c) {
      return c.path === path && (c.src || D.WORKTREE_ID) === src;
    }).length;
    const entry = this.boxes.get(path);
    if (entry != null) {
      entry.count.textContent = n > 0 ? D.plural(n, "comment") : "";
    }
  };

  View.prototype.updateCount = function () {
    const n = this.comments().length;
    this.sendBtn.hidden = n === 0;
    this.sendBtn.textContent = "Send " + D.plural(n, "comment");
  };

  View.prototype.send = async function () {
    const self = this;
    const rt = this.runtime;
    if (this.comments().length === 0 || this.sending) {
      return;
    }
    if (rt == null || typeof rt.send !== "function") {
      CC.ui.toast("This pane has no chat to send to.", { level: "error" });
      return;
    }
    if (typeof rt.mode === "function" && rt.mode() === "terminal") {
      CC.ui.toast("This chat is in terminal mode. Come back to the chat to send your comments.", { level: "error" });
      return;
    }
    const entry = {
      id: util.uid(), images: [], previews: [], createdAt: Date.now(),
      text: D.message(this.comments(), this.files.map(function (f) {
        return f.path;
      })),
    };
    this.sending = true;
    try {
      if (rt.queue != null && typeof rt.status === "function" && rt.status() !== "idle") {
        rt.queue.add(entry);
      } else {
        await rt.send(entry);
      }
    } catch (e) {
      if (typeof rt.dismissSend === "function") {
        rt.dismissSend(entry.id);
      }
      CC.ui.toast("Your comments weren't sent: " + (e && e.message ? e.message : e), { level: "error" });
      return;
    } finally {
      this.sending = false;
    }
    if (this.disposed) {
      return;
    }
    this.drafts.comments = [];
    this.drafts.saveComments();
    this.updateCount();
    this.files.forEach(function (f) {
      self.updateHeadCount(f.path);
      self.updateItem(f.path);
    });
    this.threads.forEach(function (t, key) {
      self.renderThread(key);
    });
    this.markRanges();
    this.renderOrphans();
    CC.ui.toast("Comments sent to Claude");
  };
})();
