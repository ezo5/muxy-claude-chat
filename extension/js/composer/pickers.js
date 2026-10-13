window.CC = window.CC || {};

// Local slash commands: `/model` and `/effort` without arguments open a picker card (sent as `/model <value>` /
// `/effort <level>`); `/exit` and `/quit` stop the agent. Everything else is prompt text for the CLI.
CC.Composer.use(function (composer) {
  const util = CC.util;
  const el = util.el;
  const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
  const card = el("div", "prompt-card picker-card hidden");
  card.tabIndex = -1;
  composer.above.appendChild(card);
  const brain = composer.button("brain", "Model & effort (/model)", function () {
    openModels();
  });
  composer.left.appendChild(brain);
  let rows = [];
  let cursor = 0;

  composer.on("beforeSubmit", function () {
    const v = composer.value().trim();
    if (/^\/(exit|quit)$/.test(v)) {
      composer.setValue("");
      Promise.resolve(composer.deps.stop()).catch(function (e) {
        util.toast("Stop failed: " + (e && e.message ? e.message : e), "error");
      });
      return true;
    }
    if (v === "/model") {
      composer.setValue("");
      openModels();
      return true;
    }
    if (v === "/effort") {
      composer.setValue("");
      openEfforts();
      return true;
    }
    return false;
  });

  function currentModel() {
    const m = composer.meta;
    const id = m.modelId || m.model || "";
    return (m.models || []).find(function (x) {
      return x.value === m.model || x.resolvedModel === id || (x.value && id.indexOf(x.value) >= 0);
    }) || null;
  }

  composer.on("meta", function (m) {
    brain.title = "Model & effort" + (m.model ? ": " + util.modelLabel(m) : "") + " (/model)";
    return false;
  });

  function effortLevels() {
    const cur = currentModel();
    return cur != null && cur.supportedEffortLevels != null && cur.supportedEffortLevels.length > 0 ? cur.supportedEffortLevels : EFFORTS;
  }

  function effortSeg(levels) {
    const seg = el("div", "effort-seg");
    levels.forEach(function (lv) {
      const b = el("button", "effort-opt" + (lv === composer.meta.effort ? " chosen" : ""), lv);
      b.type = "button";
      b.addEventListener("mousedown", function (e) {
        e.preventDefault();
      });
      b.addEventListener("click", function () {
        send("/effort " + lv);
      });
      seg.appendChild(b);
    });
    return seg;
  }

  function send(text) {
    hide();
    composer.dispatch({ id: util.uid(), text: text, images: [], createdAt: Date.now() }, false);
  }

  function openModels() {
    const models = composer.meta.models || [];
    if (models.length === 0) {
      util.toast("Model list not available yet");
      return;
    }
    const cur = currentModel();
    let effort = null;
    if (cur == null || cur.supportsEffort) {
      effort = el("div", "picker-effort");
      effort.appendChild(el("span", "picker-effort-label", "Effort"));
      effort.appendChild(effortSeg(effortLevels()));
    }
    show("Model & effort", "brain", models.map(function (m) {
      const bits = [m.description || ""];
      if (m.supportedEffortLevels != null && m.supportedEffortLevels.length > 0) {
        bits.push("effort " + m.supportedEffortLevels.join("/"));
      }
      return { label: m.displayName || m.value, desc: bits.filter(Boolean).join(" · "), chosen: cur != null && cur.value === m.value, value: m.value };
    }), function (r) {
      send("/model " + r.value);
    }, null, effort);
  }

  function openEfforts() {
    const levels = effortLevels();
    show("Reasoning effort", "brain", levels.map(function (lv) {
      return { label: lv, chosen: lv === composer.meta.effort, value: lv };
    }), function (r) {
      send("/effort " + r.value);
    }, effortSeg(levels));
  }

  function show(title, iconName, list, onPick, custom, extra) {
    rows = list;
    cursor = Math.max(0, list.findIndex(function (r) {
      return r.chosen === true;
    }));
    card.textContent = "";
    card.classList.remove("hidden");
    const head = el("div", "prompt-head");
    head.appendChild(util.icon(iconName));
    head.appendChild(el("span", "prompt-title", title));
    const close = el("button", "icon-btn picker-close");
    close.type = "button";
    close.title = "Close (Esc)";
    close.appendChild(util.icon("x"));
    close.addEventListener("click", hide);
    head.appendChild(close);
    card.appendChild(head);
    if (custom != null) {
      card.appendChild(custom);
    } else {
      const box = el("div", "prompt-options picker-list");
      list.forEach(function (r, i) {
        const row = el("div", "prompt-option picker-row" + (r.chosen ? " chosen" : ""));
        row.appendChild(el("span", "prompt-num", String(i + 1)));
        const body = el("div", "prompt-body");
        body.appendChild(el("div", "prompt-label", r.label));
        if (r.desc) {
          body.appendChild(el("div", "prompt-opt-desc", r.desc));
        }
        row.appendChild(body);
        row.addEventListener("mousedown", function (e) {
          e.preventDefault();
        });
        row.addEventListener("click", function () {
          onPick(r);
        });
        box.appendChild(row);
      });
      card.appendChild(box);
    }
    if (extra != null) {
      card.appendChild(extra);
    }
    const hints = el("div", "prompt-hints");
    [["↑↓", "move"], ["Enter", "choose"], ["Esc", "close"]].forEach(function (it) {
      const s = el("span");
      s.append(el("kbd", null, it[0]), document.createTextNode(" " + it[1]));
      hints.appendChild(s);
    });
    card.appendChild(hints);
    card.onkeydown = function (e) {
      let handled = true;
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || (custom != null && (e.key === "ArrowRight" || e.key === "ArrowLeft"))) {
        cursor = (cursor + (e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1) + rows.length) % rows.length;
        paint();
      } else if (e.key === "Enter") {
        if (rows[cursor] != null) {
          onPick(rows[cursor]);
        }
      } else if (e.key === "Escape") {
        hide();
      } else if (/^[1-9]$/.test(e.key) && rows[Number(e.key) - 1] != null) {
        onPick(rows[Number(e.key) - 1]);
      } else {
        handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    paint();
    card.focus({ preventScroll: true });
  }

  function paint() {
    card.querySelectorAll(".picker-row, .effort-opt").forEach(function (r, i) {
      r.classList.toggle("cursor", i === cursor);
      if (i === cursor) {
        r.scrollIntoView({ block: "nearest" });
      }
    });
  }

  function hide() {
    const had = card.contains(document.activeElement);
    card.classList.add("hidden");
    card.textContent = "";
    rows = [];
    if (had) {
      composer.focus();
    }
  }

  composer.openModelPicker = openModels;
  composer.openEffortPicker = openEfforts;
});
