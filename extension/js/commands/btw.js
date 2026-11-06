// `/btw <question>`: a side question answered by a throwaway fork of the conversation (`btw`: no tools, nothing saved), in a floating panel at
// the lower right of the pane. The main turn keeps running and never sees it. Follow-ups go to the same fork: the session id is taken once,
// and since the CLI saves nothing of a fork, the earlier questions and answers travel with each follow-up.
(function () {
  const el = CC.util.el;

  function overlayOf(card) {
    const chat = card.root.closest != null ? card.root.closest(".cc-chat") : null;
    const overlay = chat != null ? chat.querySelector(".cc-slot-overlay") : null;
    return overlay || card.root.parentElement;
  }

  function withHistory(history, question) {
    if (history.length === 0) {
      return question;
    }
    const earlier = history.map(function (h) {
      return "Question: " + h.question + "\nAnswer: " + h.answer;
    }).join("\n\n");
    return "Earlier side questions in this aside:\n\n" + earlier + "\n\nFollow-up: " + question;
  }

  function errorText(e) {
    const msg = CC.Commands.message(e);
    const m = /\{"error": (".*")\}\s*$/.exec(msg);
    return m != null ? JSON.parse(m[1]) : msg;
  }

  function panel(runtime, host) {
    const meta = runtime.meta();
    const fork = { cwd: CC.Commands.cwdOf(runtime), cliSessionId: meta.cliSessionId, model: meta.model || meta.modelId };
    const history = [];
    const root = el("div", "cc-btw cc-floating");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Side question");
    let job = null;

    const head = el("div", "cc-cmd-head");
    head.appendChild(CC.ui.icon("sparkle", 14));
    head.appendChild(el("span", "cc-cmd-title", "Side question"));
    head.appendChild(el("span", "cc-cmd-sub", "not added to the conversation"));
    head.appendChild(CC.ui.iconButton({ icon: "x", label: "Close (Esc)", size: 14, onClick: close }));
    const log = el("div", "cc-btw-log");
    const field = el("input", "cc-cmd-search cc-btw-field");
    field.type = "text";
    field.placeholder = "Ask a follow-up";
    field.setAttribute("aria-label", "Ask a follow-up");
    field.spellcheck = false;
    root.append(head, log, field);
    host.appendChild(root);

    function close() {
      if (job != null) {
        job.cancel();
      }
      const composer = runtime.composer;
      root.remove();
      if (composer != null) {
        composer.focus();
      }
    }

    async function ask(question) {
      log.appendChild(el("div", "cc-btw-question", question));
      const answer = el("div", "cc-btw-answer cc-cmd-note", "Thinking…");
      log.appendChild(answer);
      log.scrollTop = log.scrollHeight;
      field.disabled = true;
      const started = Date.now();
      const tick = setInterval(function () {
        answer.textContent = "Thinking… " + CC.util.fmtDuration(Date.now() - started);
      }, 1000);
      job = CC.Servers.of(runtime).host.job("btw", { cwd: fork.cwd, cliSessionId: fork.cliSessionId, model: fork.model, question: withHistory(history, question) }, { timeoutMs: 180000 });
      let r;
      try {
        r = await job.result;
      } catch (e) {
        r = { error: errorText(e) };
      } finally {
        clearInterval(tick);
        job = null;
      }
      if (!root.isConnected) {
        return;
      }
      field.disabled = false;
      field.focus();
      if (r.error) {
        answer.textContent = "No answer: " + r.error;
        return;
      }
      const text = r.text || "(empty answer)";
      history.push({ question: question, answer: text });
      const md = el("div", "cc-btw-answer");
      md.appendChild(CC.Commands.markdown(text, { cwd: fork.cwd }));
      answer.replaceWith(md);
      const foot = [r.ms != null ? CC.util.fmtDuration(r.ms) : null, r.cost != null ? "$" + r.cost.toFixed(3) : null, r.resumed ? null : "without the conversation (nothing saved yet)"];
      log.appendChild(el("div", "cc-btw-foot", foot.filter(Boolean).join(" · ")));
      log.scrollTop = log.scrollHeight;
    }

    field.addEventListener("keydown", function (e) {
      if (e.isComposing) {
        return;
      }
      if (e.key === "Enter" && field.value.trim() !== "") {
        const q = field.value.trim();
        field.value = "";
        ask(q);
      } else if (e.key !== "Enter") {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    });
    root.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    });
    root.ask = ask;
    return root;
  }

  CC.Commands.add("btw", function (ctx) {
    const question = ctx.arg.trim();
    if (question === "") {
      throw new Error("Usage: /btw <question>");
    }
    const host = overlayOf(ctx.card);
    const open = host.querySelector(".cc-btw");
    const box = open != null && !open.querySelector(".cc-btw-field").disabled ? open : null;
    if (box != null) {
      return box.ask(question);
    }
    if (open != null) {
      throw new Error("the side question before this one is still running");
    }
    return panel(ctx.runtime, host).ask(question);
  });
})();
