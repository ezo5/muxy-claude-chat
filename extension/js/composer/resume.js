window.CC = window.CC || {};

// `/resume` (`/continue`) without arguments: a picker of the project's earlier conversations; with an id or a unique id
// prefix it resumes that one. Both restart the agent on the session id (`claude --resume`).
CC.Composer.use(function (composer) {
  const util = CC.util;
  const el = util.el;
  const card = el("div", "prompt-card picker-card hidden");
  card.tabIndex = -1;
  composer.above.appendChild(card);

  let sessions = [];
  let shown = [];
  let cursor = 0;
  let search = null;
  let list = null;
  let seq = 0;

  composer.on("beforeSubmit", function () {
    const m = /^\/(resume|continue)(?:\s+(\S+))?\s*$/.exec(composer.value().trim());
    if (m == null) {
      return false;
    }
    composer.setValue("");
    if (m[2] != null) {
      resumeId(m[2]);
    } else {
      open();
    }
    return true;
  });

  async function resumeId(q) {
    try {
      const res = await composer.deps.sessions();
      const list = res.sessions || [];
      let hits = list.filter(function (s) {
        return s.id === q;
      });
      if (hits.length === 0) {
        hits = list.filter(function (s) {
          return s.id.indexOf(q) === 0;
        });
      }
      if (hits.length !== 1) {
        util.toast(hits.length === 0 ? "No conversation with id " + q : q + " matches " + hits.length + " conversations — type more of the id", "error");
        return;
      }
      pick(hits[0]);
    } catch (e) {
      util.toast("Cannot list conversations: " + (e && e.message ? e.message : e), "error");
    }
  }

  function ago(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) {
      return "just now";
    }
    if (s < 3600) {
      return Math.floor(s / 60) + "m ago";
    }
    if (s < 86400) {
      return Math.floor(s / 3600) + "h ago";
    }
    if (s < 86400 * 30) {
      return Math.floor(s / 86400) + "d ago";
    }
    return new Date(ms).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  }

  function size(n) {
    return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  }

  async function open() {
    const my = ++seq;
    card.textContent = "";
    card.classList.remove("hidden");
    const head = el("div", "prompt-head");
    head.appendChild(util.icon("clock"));
    head.appendChild(el("span", "prompt-title", "Resume a conversation"));
    const close = el("button", "icon-btn picker-close");
    close.type = "button";
    close.title = "Close (Esc)";
    close.appendChild(util.icon("x"));
    close.addEventListener("click", hide);
    head.appendChild(close);
    search = el("input", "picker-search");
    search.type = "text";
    search.placeholder = "Search by title, prompt or date…";
    search.spellcheck = false;
    search.addEventListener("input", filter);
    search.addEventListener("keydown", onKey);
    list = el("div", "prompt-options picker-list");
    list.appendChild(el("div", "picker-empty", "Loading…"));
    const hints = el("div", "prompt-hints");
    [["↑↓", "move"], ["Enter", "resume"], ["Esc", "close"]].forEach(function (it) {
      const s = el("span");
      s.append(el("kbd", null, it[0]), document.createTextNode(" " + it[1]));
      hints.appendChild(s);
    });
    card.append(head, search, list, hints);
    search.focus();
    try {
      const res = await composer.deps.sessions();
      if (my !== seq) {
        return;
      }
      sessions = res.sessions || [];
      filter();
    } catch (e) {
      if (my === seq) {
        list.textContent = "";
        list.appendChild(el("div", "picker-empty", "Cannot list conversations: " + (e && e.message ? e.message : e)));
      }
    }
  }

  function hide() {
    seq++;
    const had = card.contains(document.activeElement);
    card.classList.add("hidden");
    card.textContent = "";
    if (had) {
      composer.focus();
    }
  }

  function filter() {
    const q = search.value.trim().toLowerCase();
    shown = sessions.filter(function (s) {
      const d = new Date(s.mtime);
      const when = [ago(s.mtime), d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }), d.toLocaleDateString(), d.toISOString().slice(0, 10)];
      return q === "" || [s.title, s.prompt, s.branch, s.id].concat(when).join(" ").toLowerCase().indexOf(q) >= 0;
    });
    cursor = 0;
    render();
  }

  function render() {
    list.textContent = "";
    if (shown.length === 0) {
      list.appendChild(el("div", "picker-empty", sessions.length === 0 ? "No earlier conversations in this project" : "No match"));
      return;
    }
    shown.forEach(function (s, i) {
      const r = el("div", "prompt-option picker-row" + (i === cursor ? " cursor" : ""));
      const body = el("div", "prompt-body");
      body.appendChild(el("div", "prompt-label picker-title", s.title || s.prompt));
      if (s.title && s.prompt) {
        body.appendChild(el("div", "prompt-opt-desc picker-prompt", s.prompt));
      }
      const sub = el("div", "picker-sub");
      sub.appendChild(el("span", null, ago(s.mtime)));
      if (s.branch) {
        sub.appendChild(util.branchChip(s.branch, "picker-branch"));
      }
      sub.appendChild(el("span", null, size(s.size)));
      body.appendChild(sub);
      r.title = new Date(s.mtime).toLocaleString() + "\n" + s.id;
      r.appendChild(body);
      r.addEventListener("mousedown", function (e) {
        e.preventDefault();
      });
      r.addEventListener("click", function () {
        pick(s);
      });
      list.appendChild(r);
    });
  }

  function move(d) {
    if (shown.length === 0) {
      return;
    }
    cursor = Math.max(0, Math.min(shown.length - 1, cursor + d));
    list.querySelectorAll(".picker-row").forEach(function (r, i) {
      r.classList.toggle("cursor", i === cursor);
      if (i === cursor) {
        r.scrollIntoView({ block: "nearest" });
      }
    });
  }

  function pick(s) {
    hide();
    Promise.resolve(composer.deps.restart({ sessionId: s.id, resume: true })).catch(function (e) {
      util.toast("Resume failed: " + (e && e.message ? e.message : e), "error");
    });
  }

  function onKey(e) {
    if (e.isComposing) {
      return;
    }
    let handled = true;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      move(e.key === "PageDown" ? 8 : -8);
    } else if (e.key === "Enter") {
      if (shown[cursor] != null) {
        pick(shown[cursor]);
      }
    } else if (e.key === "Escape") {
      hide();
    } else {
      handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
});
