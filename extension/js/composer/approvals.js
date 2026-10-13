window.CC = window.CC || {};

// Answers the daemon's pending control requests (permissions, plan approval, AskUserQuestion) from a card above the
// composer. Source: composer.setPending(store.pending); actions go through deps.respond / deps.control.
CC.Composer.use(function (composer) {
  const util = CC.util;
  const el = util.el;
  const DENY_MESSAGE = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
  const QUESTION_DECLINED = "User declined to answer the question.";
  const MODES = { acceptEdits: "accept edits", plan: "plan mode", bypassPermissions: "bypass permissions", default: "ask before edits", dontAsk: "don't ask" };
  const card = el("div", "prompt-card hidden");
  card.tabIndex = -1;
  composer.above.appendChild(card);
  composer.promptState = null;

  let p = null;
  let acting = false;

  composer.on("pending", function (list) {
    sync(list || []);
    return false;
  });

  composer.on("focus", function () {
    if (composer.promptState !== "active") {
      return false;
    }
    focusCursor();
    return true;
  });

  function setState(st) {
    if (composer.promptState !== st) {
      composer.promptState = st;
      composer.emit("prompt", st);
    }
  }

  function sync(list) {
    const req = list[0] || null;
    if (req == null) {
      hide();
      return;
    }
    if (p != null && p.requestId === req.requestId) {
      return;
    }
    p = model(req);
    acting = false;
    const typing = document.activeElement === composer.input && composer.value() !== "";
    build();
    card.classList.remove("hidden");
    setState("active");
    if (!typing) {
      focusCursor();
    }
  }

  function hide() {
    const had = card.contains(document.activeElement);
    p = null;
    card.classList.add("hidden");
    card.textContent = "";
    setState(null);
    if (had) {
      composer.input.focus();
    }
  }

  // --- view model ---

  function suggestionLabel(s) {
    if (s.type === "setMode") {
      return "Yes, and " + (MODES[s.mode] || s.mode) + " for this session";
    }
    if (s.type === "addRules") {
      const rules = (s.rules || []).map(function (r) {
        return r.ruleContent ? r.toolName + "(" + r.ruleContent + ")" : r.toolName;
      });
      return "Yes, and don't ask again for " + (rules.join(", ") || "this");
    }
    if (s.type === "addDirectories") {
      return "Yes, and allow access to " + (s.directories || []).map(util.shortPath).join(", ") + " for this session";
    }
    return "Yes, and don't ask again";
  }

  function model(req) {
    const r = req.request || {};
    const name = r.tool_name || "";
    const m = { requestId: req.requestId, request: r, tool: name, input: r.input || {}, cursor: 0, fields: {} };
    if (name === "AskUserQuestion") {
      m.kind = "question";
      m.questions = (m.input.questions || []).map(function (q) {
        const opts = (q.options || []).map(function (o) {
          return { label: o.label, desc: o.description || "", preview: o.preview || null, checked: q.multiSelect === true ? false : null };
        });
        opts.push({ label: "Other", input: true, placeholder: "Type something…", checked: null });
        return { q: q, options: opts, multi: q.multiSelect === true, answer: null, other: "" };
      });
      m.qi = 0;
      m.options = m.questions.length > 0 ? m.questions[0].options : [];
    } else if (name === "ExitPlanMode") {
      m.kind = "plan";
      m.options = [
        { label: "Approve", desc: "Claude starts working on it", act: "allow" },
        { label: "Approve and auto-accept edits", desc: "Switches this session to accept edits", act: "allow", mode: "acceptEdits" },
        { label: "Keep planning", act: "deny", input: true, placeholder: "What should change?" },
      ];
    } else {
      m.kind = "permission";
      m.options = [{ label: "Yes", act: "allow" }];
      (r.permission_suggestions || []).forEach(function (s) {
        m.options.push({ label: suggestionLabel(s), act: "allow", permissions: [s] });
      });
      m.options.push({ label: "No", act: "deny", input: true, placeholder: "Tell Claude what to do differently…" });
    }
    return m;
  }

  function question() {
    return p.kind === "question" ? p.questions[p.qi] : null;
  }

  // --- rendering ---

  function permissionTitle() {
    const name = p.tool;
    if (name === "Bash") {
      return "Claude wants to run a command";
    }
    if (name === "Write") {
      return "Claude wants to create a file";
    }
    if (/^(Edit|MultiEdit|NotebookEdit)$/.test(name)) {
      return "Claude wants to edit a file";
    }
    if (name === "WebFetch" || name === "WebSearch") {
      return "Claude wants to open a web page";
    }
    return name ? "Claude wants to use " + name : "Claude needs your permission";
  }

  function header() {
    const head = el("div", "prompt-head");
    const icons = { permission: "shield", plan: "list", question: "sparkle" };
    head.appendChild(util.icon(icons[p.kind]));
    const q = question();
    if (p.kind === "question" && p.questions.length > 1) {
      const tabs = el("div", "prompt-tabs");
      p.questions.forEach(function (it, i) {
        const chip = el("span", "prompt-tab" + (it.answer != null ? " done" : ""), it.q.header || "Q" + (i + 1));
        if (it.answer != null) {
          chip.prepend(util.icon("check"));
        }
        chip.classList.toggle("current", i === p.qi);
        chip.addEventListener("click", function () {
          switchQuestion(i);
        });
        tabs.appendChild(chip);
      });
      head.appendChild(tabs);
    } else {
      const titles = { permission: permissionTitle(), plan: "Claude has a plan ready", question: q != null && q.q.header ? q.q.header : "Claude has a question" };
      head.appendChild(el("span", "prompt-title", titles[p.kind]));
    }
    return head;
  }

  function params(input) {
    const pre = el("pre", "prompt-code");
    pre.textContent = Object.keys(input).map(function (k) {
      const v = input[k];
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return k + ": " + (s.length > 400 ? s.slice(0, 400) + "…" : s);
    }).join("\n");
    return pre;
  }

  function context() {
    const box = el("div", "prompt-context");
    const input = p.input;
    if (p.kind === "plan") {
      const plan = el("div", "prompt-plan");
      plan.appendChild(CC.markdown.render(String(input.plan || "")));
      box.appendChild(plan);
      return box;
    }
    if (p.kind === "question") {
      return null;
    }
    if (p.tool === "Bash" && input.command) {
      if (input.description) {
        box.appendChild(el("div", "prompt-desc", input.description));
      }
      box.appendChild(el("pre", "prompt-code", input.command));
      return box;
    }
    const d = /^(Edit|MultiEdit|Write)$/.test(p.tool) ? CC.tools.inputDiff(p.tool, input) : null;
    if (d != null) {
      const file = el("div", "prompt-file");
      file.appendChild(util.icon(p.tool === "Write" ? "file" : "pencil"));
      file.appendChild(el("span", "prompt-path", util.shortPath(input.file_path || "")));
      const counts = el("span", "prompt-counts");
      if (d.add > 0) {
        counts.appendChild(el("span", "plus", "+" + d.add));
      }
      if (d.del > 0) {
        counts.appendChild(el("span", "minus", "−" + d.del));
      }
      file.appendChild(counts);
      file.title = input.file_path || "";
      d.node.classList.add("prompt-diff");
      box.append(file, d.node);
      return box;
    }
    if (p.request.description) {
      box.appendChild(el("div", "prompt-desc", p.request.description));
    }
    if (Object.keys(input).length > 0) {
      box.appendChild(params(input));
    }
    return box.childNodes.length > 0 ? box : null;
  }

  function build() {
    card.textContent = "";
    const q = question();
    card.className = "prompt-card kind-" + p.kind + (q != null && q.multi ? " multi" : "");
    card.appendChild(header());
    const ctx = context();
    if (ctx != null) {
      card.appendChild(ctx);
    }
    if (q != null) {
      card.appendChild(el("div", "prompt-question", q.q.question));
    }
    const list = el("div", "prompt-options");
    p.fields = {};
    p.options.forEach(function (o, i) {
      list.appendChild(row(o, i));
    });
    if (q != null && q.multi) {
      const b = el("button", "prompt-submit");
      b.type = "button";
      b.append(el("span", null, p.qi < p.questions.length - 1 ? "Next" : "Submit"), el("kbd", null, "↵"));
      b.addEventListener("click", function () {
        advance();
      });
      list.appendChild(b);
    }
    card.appendChild(list);
    card.appendChild(hints());
    paint();
  }

  function row(o, i) {
    const r = el("div", "prompt-option");
    r.dataset.i = i;
    const num = el("span", "prompt-num");
    if (o.checked != null) {
      num.classList.add("box");
    } else {
      num.textContent = String(i + 1);
    }
    r.appendChild(num);
    const body = el("div", "prompt-body");
    if (o.input) {
      const field = el("input", "prompt-field");
      field.type = "text";
      field.spellcheck = false;
      field.placeholder = o.placeholder || "";
      const q = question();
      field.value = q != null ? q.other : "";
      field.addEventListener("focus", function () {
        if (p != null && p.cursor !== i) {
          p.cursor = i;
          paint();
        }
      });
      field.addEventListener("input", function () {
        if (q != null) {
          q.other = field.value;
        }
      });
      p.fields[i] = field;
      body.appendChild(field);
    } else {
      body.appendChild(el("div", "prompt-label", o.label));
      if (o.desc) {
        body.appendChild(el("div", "prompt-opt-desc", o.desc));
      }
      if (o.preview) {
        body.appendChild(el("pre", "prompt-preview", o.preview));
      }
      if (o.act === "deny" || /^No\b/.test(o.label)) {
        r.classList.add("muted");
      }
    }
    r.appendChild(body);
    r.addEventListener("mousedown", function (e) {
      if (!e.target.classList.contains("prompt-field")) {
        e.preventDefault();
      }
    });
    r.addEventListener("click", function (e) {
      if (e.target.classList.contains("prompt-field")) {
        return;
      }
      p.cursor = i;
      paint();
      press(i);
    });
    return r;
  }

  function hints() {
    const h = el("div", "prompt-hints");
    const q = question();
    const n = p.options.length;
    const items = [["↑↓", "move"], ["1–" + Math.min(n, 9), q != null && q.multi ? "toggle" : "pick"]];
    if (q != null && q.multi) {
      items.push(["Space", "toggle"], ["Enter", p.qi < p.questions.length - 1 ? "next" : "submit"]);
    } else {
      items.push(["Enter", "confirm"]);
    }
    if (p.kind === "question" && p.questions.length > 1) {
      items.push(["Tab", "question"]);
    }
    items.push(["Esc", p.kind === "question" ? "skip" : "deny"]);
    items.forEach(function (it) {
      const s = el("span");
      s.append(el("kbd", null, it[0]), document.createTextNode(" " + it[1]));
      h.appendChild(s);
    });
    return h;
  }

  function paint() {
    const q = question();
    card.querySelectorAll(".prompt-options > *").forEach(function (r, i) {
      const o = p.options[i];
      r.classList.toggle("cursor", i === p.cursor);
      if (o == null) {
        return;
      }
      const num = r.querySelector(".prompt-num");
      if (num != null && num.classList.contains("box")) {
        num.textContent = "";
        num.appendChild(util.icon(o.checked ? "checkSquare" : "square"));
        r.classList.toggle("checked", o.checked === true);
      }
      r.classList.toggle("chosen", q != null && !q.multi && q.answer != null && q.answer === o.label && !o.input);
    });
  }

  function focusCursor() {
    if (p == null) {
      return;
    }
    const field = p.fields[p.cursor];
    if (field != null) {
      field.focus();
    } else {
      card.focus({ preventScroll: true });
    }
  }

  function moveTo(i) {
    if (i < 0 || i >= p.options.length) {
      return;
    }
    p.cursor = i;
    paint();
    focusCursor();
  }

  function fieldIndex() {
    return p.options.findIndex(function (o) {
      return o.input === true;
    });
  }

  // --- actions ---

  function act(fn) {
    if (acting) {
      return;
    }
    acting = true;
    Promise.resolve().then(fn).catch(function (e) {
      acting = false;
      util.toast("Answer failed: " + (e && e.message ? e.message : e), "error");
    });
  }

  function allow(o) {
    const id = p.requestId;
    const extra = { updatedInput: p.input };
    if (o.permissions != null) {
      extra.updatedPermissions = o.permissions;
    }
    const mode = o.mode;
    act(async function () {
      await composer.deps.respond(id, "allow", extra);
      if (mode != null) {
        await composer.deps.control("set_permission_mode", { mode: mode });
      }
    });
  }

  function deny(text) {
    const id = p.requestId;
    const message = text || (p.kind === "plan" ? "Keep planning." : p.kind === "question" ? QUESTION_DECLINED : DENY_MESSAGE);
    act(function () {
      return composer.deps.respond(id, "deny", { message: message });
    });
  }

  function submitAnswers() {
    const missing = p.questions.findIndex(function (it) {
      return it.answer == null;
    });
    if (missing >= 0) {
      switchQuestion(missing);
      return;
    }
    const answers = {};
    p.questions.forEach(function (it) {
      answers[it.q.question] = it.answer;
    });
    const id = p.requestId;
    const input = { questions: p.input.questions, answers: answers };
    act(function () {
      return composer.deps.respond(id, "allow", { updatedInput: input });
    });
  }

  // Saves the current question's answer (multi: checked labels, "Other": the typed text) and moves on.
  function advance() {
    const q = question();
    if (q.multi) {
      const picks = q.options.filter(function (o) {
        return o.checked === true;
      }).map(function (o) {
        return o.label;
      });
      if (q.other.trim() !== "") {
        picks.push(q.other.trim());
      }
      q.answer = picks.length > 0 ? picks.join(", ") : null;
    }
    if (q.answer == null) {
      return;
    }
    if (p.qi < p.questions.length - 1) {
      switchQuestion(p.qi + 1);
    } else {
      submitAnswers();
    }
  }

  function switchQuestion(i) {
    if (i < 0 || i >= p.questions.length || i === p.qi) {
      return;
    }
    p.qi = i;
    p.options = p.questions[i].options;
    p.cursor = 0;
    build();
    focusCursor();
  }

  function press(i) {
    const o = p.options[i];
    if (o == null) {
      return;
    }
    const q = question();
    if (o.input) {
      const field = p.fields[i];
      const text = field != null ? field.value.trim() : "";
      if (q != null) {
        if (q.multi) {
          advance();
          return;
        }
        if (text === "") {
          focusCursor();
          return;
        }
        q.answer = text;
        advance();
        return;
      }
      if (text === "" && p.kind === "permission") {
        deny(null);
        return;
      }
      deny(text);
      return;
    }
    if (q != null) {
      if (q.multi) {
        o.checked = !o.checked;
        paint();
        return;
      }
      q.answer = o.label;
      advance();
      return;
    }
    if (o.act === "allow") {
      allow(o);
    } else {
      deny(null);
    }
  }

  function typeInto(ch) {
    const i = fieldIndex();
    if (i < 0) {
      return false;
    }
    moveTo(i);
    const field = p.fields[i];
    field.value += ch;
    field.dispatchEvent(new Event("input"));
    return true;
  }

  card.addEventListener("keydown", function (e) {
    if (p == null || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) {
      return;
    }
    const inField = e.target.classList.contains("prompt-field");
    const q = question();
    let handled = true;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      moveTo(p.cursor + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter") {
      if (q != null && q.multi) {
        advance();
      } else {
        press(p.cursor);
      }
    } else if (e.key === "Escape") {
      deny(null);
    } else if (e.key === "Tab" && q != null && p.questions.length > 1) {
      switchQuestion((p.qi + (e.shiftKey ? -1 : 1) + p.questions.length) % p.questions.length);
    } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && q != null && p.questions.length > 1 && !inField) {
      switchQuestion((p.qi + (e.key === "ArrowLeft" ? -1 : 1) + p.questions.length) % p.questions.length);
    } else if (inField) {
      handled = false;
    } else if (/^[1-9]$/.test(e.key)) {
      const i = Number(e.key) - 1;
      if (i < p.options.length) {
        if (p.options[i].input) {
          moveTo(i);
        } else {
          p.cursor = i;
          paint();
          press(i);
        }
      }
    } else if (e.key === " " && q != null && q.multi) {
      if (p.options[p.cursor] != null && p.options[p.cursor].checked != null) {
        press(p.cursor);
      }
    } else if (e.key.length === 1 && e.key !== " ") {
      handled = typeInto(e.key);
    } else {
      handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
});
