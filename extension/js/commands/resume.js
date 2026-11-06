// `/resume` (`/continue`) without arguments: a picker of the project's earlier conversations; with an id or a unique id prefix it resumes
// that one, in the pane it was asked from. From 3 typed characters a second section lists conversations whose prompts or answers contain
// the text (`searchSessions`). The conversation opens through CC.Chats, as its row if it has one, else as a new chat that resumes it.
(function () {
  const el = CC.util.el;

  function ago(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) {
      return "just now";
    }
    if (s < 3600) {
      return Math.floor(s / 60) + " min ago";
    }
    if (s < 86400) {
      return Math.floor(s / 3600) + " h ago";
    }
    if (s < 86400 * 30) {
      return Math.floor(s / 86400) + " d ago";
    }
    return new Date(ms).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  }

  function size(n) {
    return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  }

  function scope(runtime) {
    const meta = runtime.meta();
    return { cwd: CC.Commands.cwdOf(runtime), current: meta.cliSessionId || runtime.id };
  }

  // In place: the pane the command came from is the one that changes.
  function showInPane(card, chatId) {
    const pane = card.root.closest != null ? card.root.closest("[data-pane-id]") : null;
    if (pane != null) {
      CC.Shell.focus(pane.dataset.paneId);
    }
    CC.Shell.open({ kind: "chat", chatId: chatId });
  }

  async function resume(ctx, session) {
    try {
      const known = CC.Chats.rows().find(function (r) {
        // A chat's first conversation has the chat's id; after a /clear that id no longer says what the chat shows.
        return r.kind === "chat" && (r.cliSessionId === session.id || (r.cliSessionId == null && r.id === session.id));
      });
      const id = known != null ? known.id : await CC.Chats.create({ cwd: CC.Commands.cwdOf(ctx.runtime), server: CC.Servers.of(ctx.runtime).key, cliSessionId: session.id, resume: true });
      showInPane(ctx.card, id);
    } catch (e) {
      CC.Commands.toast("Resume failed: " + CC.Commands.message(e), "error");
    }
  }

  async function byId(ctx, q) {
    let list;
    try {
      const res = await CC.Servers.of(ctx.runtime).host.call("sessions", scope(ctx.runtime));
      list = res.sessions || [];
    } catch (e) {
      CC.Commands.toast("Cannot list conversations: " + CC.Commands.message(e), "error");
      return;
    }
    let hits = list.filter(function (s) {
      return s.id === q;
    });
    if (hits.length === 0) {
      hits = list.filter(function (s) {
        return s.id.indexOf(q) === 0;
      });
    }
    if (hits.length !== 1) {
      CC.Commands.toast(hits.length === 0 ? "No conversation with id " + q : q + " matches " + hits.length + " conversations, type more of the id", "error");
      return;
    }
    await resume(ctx, hits[0]);
  }

  async function picker(ctx) {
    const card = ctx.card;
    const body = card.open("clock", "Resume a conversation");
    const search = el("input", "cc-cmd-search");
    search.type = "text";
    search.placeholder = "Search by title, date or message text";
    search.setAttribute("aria-label", search.placeholder);
    search.spellcheck = false;
    const list = el("div", "cc-cmd-list-box");
    list.appendChild(el("div", "cc-cmd-empty", "Loading…"));
    body.append(search, list);
    card.hints([["↑↓", "move"], ["Enter", "resume"]]);
    search.focus();

    let sessions = [];
    let titled = [];
    let found = [];
    let foundNote = "";
    let shown = [];
    let searching = false;
    let job = null;
    let timer = 0;
    let cursor = 0;

    function alive() {
      return card.root.contains(list);
    }

    function stopSearch() {
      clearTimeout(timer);
      if (job != null) {
        job.cancel();
        job = null;
      }
    }

    function marked(text, q) {
      const box = el("span", "cc-cmd-row-desc");
      const at = text.toLowerCase().indexOf(q.toLowerCase());
      if (at < 0) {
        box.textContent = text;
        return box;
      }
      box.append(document.createTextNode(text.slice(0, at)), el("mark", null, text.slice(at, at + q.length)), document.createTextNode(text.slice(at + q.length)));
      return box;
    }

    function row(s, i, q) {
      const r = el("button", "cc-cmd-row" + (i === cursor ? " is-cursor" : ""));
      r.type = "button";
      r.tabIndex = -1;
      const main = el("span", "cc-cmd-row-body");
      main.appendChild(el("span", "cc-cmd-row-title", s.title || s.prompt));
      if (s.snippet != null) {
        main.appendChild(marked((s.role === "user" ? "You: " : "Claude: ") + s.snippet, q));
      } else if (s.title && s.prompt) {
        main.appendChild(el("span", "cc-cmd-row-desc", s.prompt));
      }
      const bits = [ago(s.mtime), s.branch, size(s.size), s.hits > 1 ? s.hits + " matches" : null];
      main.appendChild(el("span", "cc-cmd-row-sub", bits.filter(Boolean).join(" · ")));
      r.title = new Date(s.mtime).toLocaleString() + "\n" + s.id;
      r.appendChild(main);
      r.addEventListener("mousedown", function (e) {
        e.preventDefault();
      });
      r.addEventListener("click", function () {
        pick(s);
      });
      return r;
    }

    function render() {
      list.replaceChildren();
      shown = titled.concat(found);
      const q = search.value.trim();
      const inMessages = q.length >= 3;
      if (titled.length === 0 && !inMessages) {
        list.appendChild(el("div", "cc-cmd-empty", sessions.length === 0 ? "No earlier conversations in this project" : "No match"));
        return;
      }
      titled.forEach(function (s, i) {
        list.appendChild(row(s, i, q));
      });
      if (!inMessages) {
        return;
      }
      const head = el("div", "cc-cmd-section", "In messages");
      const note = searching ? "searching…" : foundNote;
      if (note) {
        head.appendChild(el("span", "cc-cmd-section-note", note));
      }
      list.appendChild(head);
      found.forEach(function (s, i) {
        list.appendChild(row(s, titled.length + i, q));
      });
    }

    async function searchMessages(q) {
      const mine = CC.Servers.of(ctx.runtime).host.job("searchSessions", Object.assign(scope(ctx.runtime), { q: q }));
      job = mine;
      let res;
      try {
        res = await mine.result;
      } catch (e) {
        res = { matches: [], error: CC.Commands.message(e) };
      }
      if (!alive() || job !== mine) {
        return;
      }
      job = null;
      searching = false;
      found = (res.matches || []).filter(function (m) {
        return !titled.some(function (s) {
          return s.id === m.id;
        });
      });
      foundNote = res.error ? "search failed: " + res.error : found.length === 0 ? "nothing else found" : res.partial === true ? "newest " + found.length : "";
      render();
    }

    function filter() {
      const q = search.value.trim().toLowerCase();
      titled = sessions.filter(function (s) {
        const d = new Date(s.mtime);
        const when = [ago(s.mtime), d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }), d.toLocaleDateString(), d.toISOString().slice(0, 10)];
        return q === "" || [s.title, s.prompt, s.branch, s.id].concat(when).join(" ").toLowerCase().indexOf(q) >= 0;
      });
      stopSearch();
      found = [];
      foundNote = "";
      searching = q.length >= 3;
      if (searching) {
        timer = setTimeout(function () {
          searchMessages(search.value.trim());
        }, 250);
      }
      cursor = 0;
      render();
    }

    function move(d) {
      if (shown.length === 0) {
        return;
      }
      cursor = Math.max(0, Math.min(shown.length - 1, cursor + d));
      list.querySelectorAll(".cc-cmd-row").forEach(function (r, i) {
        r.classList.toggle("is-cursor", i === cursor);
        if (i === cursor && r.scrollIntoView != null) {
          r.scrollIntoView({ block: "nearest" });
        }
      });
    }

    function pick(s) {
      stopSearch();
      card.close();
      resume(ctx, s);
    }

    search.addEventListener("input", filter);
    search.addEventListener("keydown", function (e) {
      if (e.isComposing) {
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        move(e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "PageDown" || e.key === "PageUp") {
        move(e.key === "PageDown" ? 8 : -8);
      } else if (e.key === "Enter") {
        if (shown[cursor] != null) {
          pick(shown[cursor]);
        }
      } else if (e.key === "Escape") {
        stopSearch();
        card.close();
      } else {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    });

    try {
      const res = await CC.Servers.of(ctx.runtime).host.call("sessions", scope(ctx.runtime));
      if (alive()) {
        sessions = res.sessions || [];
        filter();
      }
    } catch (e) {
      if (alive()) {
        list.replaceChildren(el("div", "cc-cmd-empty", "Cannot list conversations: " + CC.Commands.message(e)));
      }
    }
  }

  CC.Commands.add(["resume", "continue"], function (ctx) {
    const id = ctx.arg.split(/\s+/)[0];
    return id !== "" ? byId(ctx, id) : picker(ctx);
  });
})();
