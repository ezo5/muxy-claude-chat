
// Claude Code's start / auth failures (daemon `stopped.error` = claude stderr tail, `cli start` errors, error
// results) → what happened and the next step. Texts as of Claude Code 2.1.316.
CC.startErrors = (function () {
  const RULES = [
    [/Not logged in|Please run \/login|Invalid API key|OAuth token (has )?expired|authentication_failed/i, function () {
      return { text: "Claude is not logged in on this server.",
        hint: "Run `claude` in a terminal there and type /login (the chat cannot log in), then send a message." };
    }],
    [/keychain|User interaction is not allowed/i, function () {
      return { text: "Claude cannot read its login from the macOS keychain (locked for SSH sessions).",
        hint: "On that Mac run `security unlock-keychain ~/Library/Keychains/login.keychain-db` in an SSH session, or create a token with `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN for it, then send a message." };
    }],
    [/argument '[^']*' is invalid\. Allowed choices are/i, function (m, s) {
      const opt = /option '(--[\w-]+)/.exec(s);
      return { text: "This Claude Code does not support the chosen " + (opt != null && opt[1] === "--permission-mode" ? "permission mode" : "value of " + (opt != null ? opt[1] : "an option")) + ".",
        hint: "Update it with `claude update`, or pick another mode, then send a message." };
    }],
    [/unknown option '(--[\w-]+)'/i, function (m) {
      return { text: "This Claude Code is too old for " + m[1] + ".", hint: "Update it with `claude update` on the server, then send a message." };
    }],
    [/Session ID \S+ is already in use/i, function () {
      return { text: "Another Claude process has this conversation open.",
        hint: "Close it (e.g. the terminal running `claude --resume`) or continue there with the Terminal button, then send a message." };
    }],
    [/No conversation found with session ID/i, function () {
      return { text: "The conversation file is missing on this server.", hint: "Start a new conversation (/clear) or pick one with /resume." };
    }],
    [/claude binary not found/i, function () {
      return { text: "Claude Code is not installed on this server.",
        hint: "Install it, or set `claudeBin` in ~/.config/claude-chat/config.json, then send a message." };
    }],
  ];

  function explain(raw) {
    const s = String(raw || "");
    for (let i = 0; i < RULES.length; i++) {
      const m = RULES[i][0].exec(s);
      if (m != null) {
        return RULES[i][1](m, s);
      }
    }
    return null;
  }

  // A notice item: the explanation with its next step and the raw text folded, or the raw text alone.
  function notice(id, ts, raw, fallback) {
    const why = explain(raw);
    const detail = String(raw || "").trim() || null;
    if (why == null) {
      return fallback != null ? { k: "notice", ts: ts, id: id, level: "error", text: fallback, detail: detail } : { k: "notice", ts: ts, id: id, level: "error", text: detail || "" };
    }
    return { k: "notice", ts: ts, id: id, level: "error", text: why.text, hint: why.hint, detail: detail };
  }

  return { explain: explain, notice: notice };
})();
