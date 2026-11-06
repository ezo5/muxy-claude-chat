// `/plan [open|prompt]`: set_permission_mode plan, then sends the prompt if one was given. `/plan` while already in
// plan mode (or `/plan open`) shows the session's plan from get_plan {exists, content?, path?}.
CC.Commands.add("plan", async function (ctx) {
  const runtime = ctx.runtime;
  const util = CC.util;
  const el = util.el;
  const composer = ctx.composer;
  const card = ctx.card;
  const inPlan = runtime.meta().permissionMode === "plan";

  if (ctx.arg === "open" || (ctx.arg === "" && inPlan)) {
    const r = await CC.Commands.control(runtime, "get_plan");
    const body = card.open("list", "Plan", r.path ? util.shortPath(r.path) : inPlan ? "plan mode on" : "");
    if (r.exists && r.content) {
      const box = el("div", "cc-cmd-plan");
      box.appendChild(CC.Commands.markdown(r.content, { cwd: runtime.meta().cwd }));
      body.appendChild(box);
      card.actions(body, [{ label: "Open in a pane", primary: true, run: function () {
        card.close();
        CC.Shell.open({ kind: "plan", chatId: runtime.id }, { beside: true });
      } }]);
    } else {
      body.appendChild(el("div", "cc-cmd-empty", inPlan ? "Plan mode is on; no plan written yet." : "No plan in this session."));
    }
    card.hints([]);
    return;
  }
  if (!inPlan) {
    await CC.Commands.control(runtime, "set_permission_mode", { mode: "plan" });
  }
  if (ctx.arg === "") {
    CC.Commands.toast("Plan mode on — Claude plans before editing");
    return;
  }
  CC.Commands.dispatch(composer, ctx.arg);
});
