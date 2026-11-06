// Answers the daemon's pending control requests (permissions, plan approval, AskUserQuestion) from a card at the end of the flow, for
// pending[0]. Under it "Needs your input" takes the place of the live line (composer.css hides the other flowEnd items). The field stays
// usable: what's entered there queues (Composer.dispatch). Answered questions and plans are history in the flow, through answeredNode.
CC.Composer.answeredNode = function (rows) {
  const el = CC.util.el;
  const box = el("div", "cmp-answered");
  rows.forEach(function (r) {
    const block = el("div", "cmp-answered-block");
    block.appendChild(el("div", "cmp-answered-q", r.q));
    block.appendChild(el("div", "cmp-answered-a", r.a));
    box.appendChild(block);
  });
  return box;
};

CC.Composer.use((function () {
  const util = CC.util;
  const el = util.el;
  const DENY_MESSAGE = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
  const QUESTION_DECLINED = "User declined to answer the question.";
  const MODES = { acceptEdits: "accept edits", plan: "plan mode", bypassPermissions: "bypass permissions", default: "ask before edits", dontAsk: "don't ask" };

  return function (composer) {
    const wrap = composer.flowEnd;
    const card = el("div", "prompt-card");
    card.tabIndex = -1;
    card.hidden = true;
    const needs = el("div", "cmp-needs");
    needs.append(el("span", "cmp-needs-ring"), el("span", "cc-chip cc-tone-need", "Needs your input"));
    needs.hidden = true;
    wrap.append(card, needs);

    let p = null;
    let acting = false;

    composer.on("pending", function (list) {
      sync(list);
      return false;
    });

    // Also after what's above the field grew and took room from the flow.
    composer.revealCard = function () {
      if (p != null && needs.scrollIntoView != null) {
        needs.scrollIntoView({ block: "nearest" });
      }
    };

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
      build();
      card.hidden = false;
      needs.hidden = false;
      wrap.classList.add("is-waiting");
      composer.revealCard();
      if (shouldTakeFocus()) {
        focusCursor();
      }
    }

    // Someone typing, here or in another pane, keeps the keyboard.
    function shouldTakeFocus() {
      const focused = composer.ctx.shell.focused();
      if (focused == null || focused.id !== composer.ctx.paneId) {
        return false;
      }
      const active = document.activeElement;
      return active !== composer.input || composer.value() === "";
    }

    function hide() {
      if (p == null) {
        return;
      }
      const had = card.contains(document.activeElement);
      p = null;
      card.hidden = true;
      card.textContent = "";
      needs.hidden = true;
      wrap.classList.remove("is-waiting");
      if (had) {
        composer.focus();
      } else {
        composer.focusIfNowhere();
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
        return "Yes, and allow access to " + (s.directories || []).map(function (d) {
          return util.shortPath(d);
        }).join(", ") + " for this session";
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
          opts.push({ label: "Other", input: true, placeholder: "Other", checked: null });
          return { q: q, options: opts, multi: q.multiSelect === true, answer: null, other: "" };
        });
        m.qi = 0;
        m.options = m.questions.length > 0 ? m.questions[0].options : [];
      } else if (name === "ExitPlanMode") {
        m.kind = "plan";
        m.options = [
          { label: "Approve", desc: "Claude starts working on it", act: "allow" },
          { label: "Approve and auto-accept edits", desc: "Switches this session to accept edits", act: "allow", mode: "acceptEdits" },
          { label: "Keep planning", act: "deny", input: true, placeholder: "Keep planning: what should change?" },
        ];
      } else {
        m.kind = "permission";
        m.options = [{ label: "Yes", act: "allow" }];
        (r.permission_suggestions || []).forEach(function (s) {
          m.options.push({ label: suggestionLabel(s), act: "allow", permissions: [s] });
        });
        m.options.push({ label: "No", act: "deny", input: true, placeholder: "No, and tell Claude what to do differently" });
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
      const q = question();
      if (q != null) {
        head.appendChild(el("span", "prompt-title", q.q.question));
        if (p.questions.length > 1) {
          head.appendChild(pager());
        }
        return head;
      }
      head.appendChild(CC.ui.icon(p.kind === "plan" ? "list" : "shield", 14));
      head.appendChild(el("span", "prompt-title", p.kind === "plan" ? "Claude has a plan ready" : permissionTitle()));
      return head;
    }

    function pager() {
      const box = el("span", "prompt-pager");
      const back = CC.ui.iconButton({
        icon: "chevron",
        label: "Previous question",
        size: 12,
        onClick: function () {
          switchQuestion(p.qi - 1);
        },
      });
      back.classList.add("is-back");
      back.disabled = p.qi === 0;
      const next = CC.ui.iconButton({
        icon: "chevron",
        label: "Next question",
        size: 12,
        onClick: function () {
          switchQuestion(p.qi + 1);
        },
      });
      next.disabled = p.qi === p.questions.length - 1;
      box.append(back, el("span", "prompt-pager-text", (p.qi + 1) + " of " + p.questions.length), next);
      return box;
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

    function planBody(text) {
      if (CC.markdown != null) {
        return CC.markdown.render(text);
      }
      return el("div", "prompt-plan-text", text);
    }

    function inputDiff() {
      return CC.tools != null && CC.tools.inputDiff != null && /^(Edit|MultiEdit|Write)$/.test(p.tool) ? CC.tools.inputDiff(p.tool, p.input) : null;
    }

    function context() {
      const box = el("div", "prompt-context");
      const input = p.input;
      if (p.kind === "plan") {
        const plan = el("div", "prompt-plan");
        plan.appendChild(planBody(String(input.plan || "")));
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
      const d = inputDiff();
      if (d != null) {
        const file = el("div", "prompt-file");
        file.appendChild(CC.ui.icon(p.tool === "Write" ? "file" : "pencil", 14));
        const path = el("span", "prompt-path", util.shortPath(input.file_path || ""));
        path.title = input.file_path || "";
        file.appendChild(path);
        file.appendChild(CC.ui.numbers(d.add, d.del));
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
      card.className = "prompt-card is-" + p.kind;
      card.appendChild(header());
      const ctx = context();
      if (ctx != null) {
        card.appendChild(ctx);
      }
      const list = el("div", "prompt-options");
      p.fields = {};
      p.options.forEach(function (o, i) {
        list.appendChild(row(o, i));
      });
      card.appendChild(list);
      const foot = el("div", "prompt-foot");
      foot.appendChild(hints());
      if (q != null) {
        foot.appendChild(CC.ui.button({
          label: "Skip",
          onClick: function () {
            deny(null);
          },
        }));
        const next = CC.ui.button({
          label: p.qi < p.questions.length - 1 ? "Next" : "Submit",
          primary: true,
          onClick: next_,
        });
        next.appendChild(el("kbd", null, CC.Composer.MOD + "↵"));
        foot.appendChild(next);
      }
      card.appendChild(foot);
      paint();
    }

    function row(o, i) {
      const r = el("div", "prompt-option");
      r.dataset.i = i;
      const q = question();
      r.appendChild(el("span", "prompt-num" + (o.checked != null ? " is-box" : q != null ? " is-radio" : ""), q == null ? String(i + 1) : null));
      const body = el("div", "prompt-body");
      if (o.input) {
        const field = el("input", "prompt-field");
        field.type = "text";
        field.spellcheck = false;
        field.placeholder = o.placeholder || "";
        field.setAttribute("aria-label", o.placeholder || o.label);
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
      const items = [["↑↓", "move"], ["1–" + Math.min(p.options.length, 9), q != null && q.multi ? "toggle" : "pick"]];
      if (q != null && q.multi) {
        items.push(["Space", "toggle"], ["Enter", p.qi < p.questions.length - 1 ? "next" : "submit"]);
      } else {
        items.push(["Enter", "confirm"]);
      }
      if (q != null && p.questions.length > 1) {
        items.push(["Tab", "question"]);
      }
      items.push(["Esc", q != null ? "skip" : "deny"]);
      items.forEach(function (it) {
        const s = el("span");
        s.append(el("kbd", null, it[0]), document.createTextNode(" " + it[1]));
        h.appendChild(s);
      });
      return h;
    }

    function paint() {
      const q = question();
      card.querySelectorAll(".prompt-option").forEach(function (r, i) {
        const o = p.options[i];
        r.classList.toggle("is-cursor", i === p.cursor);
        const num = r.querySelector(".prompt-num");
        if (o.checked != null) {
          r.classList.toggle("is-checked", o.checked === true);
          num.replaceChildren();
          if (o.checked === true) {
            num.appendChild(CC.ui.icon("check", 12));
          }
        } else if (q != null) {
          r.classList.toggle("is-checked", !q.multi && q.answer != null && (q.answer === o.label && !o.input || o.input === true && q.answer === q.other.trim()));
        }
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
        CC.ui.toast("Answer failed: " + (e && e.message ? e.message : e), { level: "error" });
      });
    }

    function allow(o) {
      const id = p.requestId;
      const extra = { updatedInput: p.input };
      if (o.permissions != null) {
        extra.updatedPermissions = o.permissions;
      }
      let mode = o.mode;
      // terminal mode answers through the TUI's hook, which has no control channel
      if (mode != null && composer.status === "terminal") {
        extra.updatedPermissions = (extra.updatedPermissions || []).concat([{ type: "setMode", mode: mode, destination: "session" }]);
        mode = null;
      }
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

    // The Next button and mod+Enter: what's under the cursor unless this question already has its answer.
    function next_() {
      const q = question();
      if (q.multi) {
        advance();
      } else if (q.answer != null && p.options[p.cursor].input !== true) {
        advance();
      } else {
        press(p.cursor);
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
      if (p == null || e.isComposing) {
        return;
      }
      const q = question();
      if (q != null && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        next_();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }
      const inField = e.target.classList.contains("prompt-field");
      const isButton = e.target.tagName === "BUTTON";
      let handled = true;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        moveTo(p.cursor + (e.key === "ArrowDown" ? 1 : -1));
      } else if (e.key === "Enter") {
        if (isButton) {
          handled = false;
        } else if (q != null && q.multi) {
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
      } else if (inField || isButton) {
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
  };
})());
