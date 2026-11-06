// `/model` and `/effort` without arguments open a picker (sent as `/model <value>` and `/effort <level>`); `/exit` and `/quit` stop the
// agent. CC.Pickers is also what the triggers under the composer call: openModel(composer), openEffort(composer), modelLabel(meta).
CC.Pickers = (function () {
  const el = CC.util.el;
  const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

  function currentModel(meta) {
    const id = meta.modelId || meta.model || "";
    return (meta.models || []).find(function (x) {
      return x.value === meta.model || x.resolvedModel === id || (x.value && id.indexOf(x.value) >= 0);
    }) || null;
  }

  function modelLabel(meta) {
    const cur = currentModel(meta);
    if (cur != null && cur.displayName) {
      return cur.displayName;
    }
    return meta.modelId || meta.model ? CC.util.prettyModel(meta.modelId || meta.model) : "";
  }

  function effortLevels(meta) {
    const cur = currentModel(meta);
    return cur != null && cur.supportedEffortLevels != null && cur.supportedEffortLevels.length > 0 ? cur.supportedEffortLevels : EFFORTS;
  }

  function send(composer, text) {
    CC.Commands.dispatch(composer, text);
  }

  // Under the model list: effort as a row of buttons, for a mouse. Keys stay on the list.
  function effortRow(composer, card, meta) {
    const box = el("div", "cc-cmd-effort");
    box.appendChild(el("span", "cc-cmd-effort-label", "Effort"));
    const seg = el("div", "cc-cmd-seg");
    effortLevels(meta).forEach(function (lv) {
      const b = el("button", "cc-cmd-row" + (lv === meta.effort ? " is-chosen" : ""), lv);
      b.type = "button";
      b.tabIndex = -1;
      b.addEventListener("mousedown", function (e) {
        e.preventDefault();
      });
      b.addEventListener("click", function () {
        card.close();
        send(composer, "/effort " + lv);
      });
      seg.appendChild(b);
    });
    box.appendChild(seg);
    return box;
  }

  function openModel(composer) {
    const meta = composer.runtime.meta();
    const card = composer.commandCard;
    const models = meta.models || [];
    if (models.length === 0) {
      CC.Commands.toast("Model list not available yet");
      return;
    }
    const cur = currentModel(meta);
    const body = card.open("brain", "Model and effort");
    card.list(body, models.map(function (m) {
      const bits = [m.description || ""];
      if (m.supportedEffortLevels != null && m.supportedEffortLevels.length > 0) {
        bits.push("effort " + m.supportedEffortLevels.join("/"));
      }
      return { label: m.displayName || m.value, desc: bits.filter(Boolean).join(" · "), chosen: cur != null && cur.value === m.value, value: m.value };
    }), {
      numbers: true,
      extra: cur == null || cur.supportsEffort ? effortRow(composer, card, meta) : null,
      onPick: function (it) {
        send(composer, "/model " + it.value);
      },
    });
  }

  function openEffort(composer) {
    const meta = composer.runtime.meta();
    const card = composer.commandCard;
    const body = card.open("brain", "Reasoning effort");
    card.list(body, effortLevels(meta).map(function (lv) {
      return { label: lv, chosen: lv === meta.effort, value: lv };
    }), {
      segment: true,
      numbers: true,
      onPick: function (it) {
        send(composer, "/effort " + it.value);
      },
    });
  }

  CC.Commands.add("model", function (ctx) {
    openModel(ctx.composer);
  }, { bare: true });

  CC.Commands.add("effort", function (ctx) {
    openEffort(ctx.composer);
  }, { bare: true });

  CC.Commands.add(["exit", "quit"], function (ctx) {
    return Promise.resolve(ctx.runtime.stop()).catch(function (e) {
      CC.Commands.toast("Stop failed: " + CC.Commands.message(e), "error");
    });
  }, { bare: true });

  return { openModel: openModel, openEffort: openEffort, modelLabel: modelLabel, currentModel: currentModel, effortLevels: effortLevels };
})();
