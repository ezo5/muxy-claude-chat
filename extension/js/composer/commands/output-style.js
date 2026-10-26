window.CC = window.CC || {};

// `/output-style [style]`: styles from the initialize reply; update_settings writes the project's local settings like
// the terminal's /output-style and applies from the next message (survives restarts).
CC.Commands.add("output-style", async function (ctx) {
  const composer = ctx.composer;
  const card = ctx.card;
  const m = composer.meta;
  const styles = Array.isArray(m.outputStyles) && m.outputStyles.length > 0 ? m.outputStyles : ["default"];
  const current = m.outputStyle || "default";

  async function apply(name) {
    try {
      await CC.Commands.control(composer, "update_settings", { source: "localSettings", settings: { outputStyle: name } });
    } catch (e) {
      CC.util.toast("Output style not set: " + e.message, "error");
      return;
    }
    composer.deps.store.setMeta({ outputStyle: name });
    CC.util.toast("Output style: " + name + " (from the next message)");
  }

  if (ctx.arg !== "") {
    const q = ctx.arg.toLowerCase();
    const hit = styles.find(function (s) {
      return s.toLowerCase() === q;
    });
    if (hit == null) {
      CC.util.toast("Unknown output style: " + ctx.arg + " (" + styles.join(", ") + ")", "error");
      return;
    }
    await apply(hit);
    return;
  }
  const body = card.open("pencil", "Output style", "current: " + current);
  card.list(body, styles.map(function (s) {
    return { label: s, desc: s === current ? "current" : "", name: s };
  }), {
    action: "apply",
    onPick: function (it) {
      apply(it.name);
    },
  });
  const i = styles.indexOf(current);
  if (i > 0) {
    card.move(i);
  }
});
