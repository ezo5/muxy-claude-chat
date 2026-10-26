window.CC = window.CC || {};

// `/fast [on|off]`: apply_flag_settings {fastMode} (this session only; also the Agent SDK opt-in). The state and the
// reason it cannot serve come from the initialize reply and each result, so they refresh after the next message.
CC.Commands.add("fast", async function (ctx) {
  const util = CC.util;
  const el = util.el;
  const composer = ctx.composer;
  const card = ctx.card;
  const REASONS = {
    free: "not available on the free plan",
    preference: "turned off by your organization's policy",
    extra_usage_disabled: "needs extra usage, which is turned off for this account",
    network_error: "status could not be fetched (network error)",
    unknown: "not available right now",
    not_first_party: "only available with the Anthropic API directly",
    disabled_by_env: "turned off by an environment variable",
    model_not_allowed: "the model is not allowed for your organization",
    sdk_opt_in_required: "off — turn it on to opt this session in",
    pending: "availability is still being checked",
  };
  const fm = composer.meta.fastMode || {};
  const on = fm.state === "on" || fm.state === "cooldown";

  async function apply(enable) {
    try {
      await CC.Commands.control(composer, "apply_flag_settings", { settings: { fastMode: enable } });
    } catch (e) {
      util.toast("Fast mode not changed: " + e.message, "error");
      return;
    }
    util.toast("Fast mode " + (enable ? "on" : "off") + " for this session (from the next message)");
  }

  const a = ctx.arg.toLowerCase();
  if (a === "on" || a === "off") {
    await apply(a === "on");
    return;
  }
  const body = card.open("sparkle", "Fast mode", fm.state || "unknown");
  card.rows(body, [
    ["State", fm.state === "cooldown" ? "cooling down after a rate limit" : fm.state || "—"],
    ["Model", composer.meta.model || composer.meta.modelId],
    ["Note", fm.reason ? REASONS[fm.reason] || fm.reason : fm.state === "on" ? "faster output, billed at the fast-mode rate" : null],
  ]);
  body.appendChild(el("div", "cmd-note", "Fast mode runs supported Opus models with faster output. The setting lasts for this chat session; the state above is updated after the next message."));
  const actions = el("div", "cmd-actions");
  const btn = el("button", "chip-btn primary", on ? "Turn off" : "Turn on");
  btn.type = "button";
  btn.addEventListener("click", function () {
    card.close();
    apply(!on);
  });
  actions.appendChild(btn);
  body.appendChild(actions);
  card.hints([]);
  btn.focus();
});
