window.CC = window.CC || {};

// `/plan [open|prompt]`: set_permission_mode plan, then sends the prompt if one was given. `/plan` while already in
// plan mode (or `/plan open`) shows the session's plan from get_plan {exists, content?, path?}.
CC.Commands.add("plan", async function (ctx) {
  const util = CC.util;
  const el = util.el;
  const composer = ctx.composer;
  const card = ctx.card;
  const inPlan = composer.meta.permissionMode === "plan";

  if (ctx.arg === "open" || (ctx.arg === "" && inPlan)) {
    const r = await CC.Commands.control(composer, "get_plan");
    const body = card.open("list", "Plan", r.path ? util.shortPath(r.path) : inPlan ? "plan mode on" : "");
    if (r.exists && r.content) {
      const box = el("div", "prompt-plan");
      box.appendChild(CC.markdown.render(r.content, { cwd: composer.meta.cwd }));
      body.appendChild(box);
    } else {
      body.appendChild(el("div", "picker-empty", inPlan ? "Plan mode is on; no plan written yet." : "No plan in this session."));
    }
    card.hints([]);
    return;
  }
  if (!inPlan) {
    await CC.Commands.control(composer, "set_permission_mode", { mode: "plan" });
  }
  if (ctx.arg === "") {
    util.toast("Plan mode on — Claude plans before editing");
    return;
  }
  composer.dispatch({ id: util.uid(), text: ctx.arg, images: [], previews: [], createdAt: Date.now() }, false);
});
