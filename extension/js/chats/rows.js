// What a row says: from an overview row, from a loaded runtime, from a terminal pane. Pure.
CC.ChatRows = (function () {
  const VERB = { Bash: "Running", BashOutput: "Running", Read: "Reading", NotebookRead: "Reading", Edit: "Editing", MultiEdit: "Editing", Write: "Editing", NotebookEdit: "Editing",
    Grep: "Searching", Glob: "Searching", LS: "Searching", WebFetch: "Fetching", WebSearch: "Searching", Agent: "Agent", Task: "Agent" };
  const TARGET_KEYS = ["command", "file_path", "notebook_path", "pattern", "url", "query", "description"];

  function targetOf(input) {
    const value = TARGET_KEYS.map(function (k) {
      return input != null ? input[k] : null;
    }).find(function (v) {
      return typeof v === "string" && v !== "";
    });
    return value != null ? CC.util.firstLine(value, 120) : "";
  }

  function nowText(tool, target) {
    const verb = tool != null ? VERB[tool] || tool : null;
    return verb == null ? null : target ? verb + " " + target : verb;
  }

  function daemonState(status, reason) {
    if (status === "waiting") {
      return "need";
    }
    if (status === "busy" || status === "starting" || status === "stopping") {
      return "busy";
    }
    if (status === "idle" || status === "error") {
      return status;
    }
    return reason === "error" ? "error" : "stopped";
  }

  function fromOverview(o) {
    const a = o.activity;
    if (a != null && (a.kind === "need" || a.kind === "busy" || a.kind === "bg")) {
      return { state: a.kind, ask: a.ask || null, req: a.req || null, now: a.kind !== "need" ? nowText(a.tool, a.target) : null, tool: a.tool || null, since: a.since || null };
    }
    return { state: daemonState(o.status, o.reason), ask: null, req: null, now: null, tool: null, since: null };
  }

  function askOf(pending) {
    const r = pending.request || pending;
    const tool = r.tool_name || r.toolName || r.tool || "a tool";
    const input = r.input || {};
    if (tool === "AskUserQuestion" && Array.isArray(input.questions) && input.questions.length > 0) {
      return input.questions[0].question || "Claude has a question";
    }
    if (tool === "ExitPlanMode") {
      return "Plan ready for review";
    }
    const target = targetOf(input);
    return "Allow " + tool + (target ? ": " + target : "");
  }

  function nowOfStore(store) {
    const a = store.activity();
    if (a == null) {
      return null;
    }
    return a.kind === "thinking" ? "Thinking" : nowText(a.item.name, targetOf(a.item.input));
  }

  // A loaded runtime over the overview. Null while it knows nothing yet. It doesn't see background work, so idle keeps an overview's bg.
  function fromRuntime(rt, base) {
    const store = rt.store;
    const status = store.status;
    if (store.pending.length > 0) {
      const first = store.pending[0];
      return { state: "need", ask: askOf(first), req: first.requestId, now: null, tool: (first.request || first).tool_name || null, since: first.ts || null };
    }
    // The overview's last look may be from before the stop, so a chat coming back from stopped says stopped until its daemon speaks.
    if (status === "connecting" && store.resuming === true) {
      return { state: "stopped", ask: null, req: null, now: null, tool: null, since: null };
    }
    if (status == null || status === "connecting") {
      return null;
    }
    if (status === "idle" && base != null && base.state === "bg") {
      return null;
    }
    const state = daemonState(status, store.statusDetail);
    const turn = store.meta.turn;
    const a = state === "busy" ? store.activity() : null;
    return { state: state, ask: state === "need" ? "Claude needs your answer" : null, req: null, now: state === "busy" ? nowOfStore(store) : null,
      tool: a != null && a.kind !== "thinking" ? a.item.name : null,
      since: state === "busy" && turn != null ? turn.startedAt || null : null };
  }

  function terminalState(status) {
    return status === "working" ? "busy" : status === "waiting" ? "need" : "idle";
  }

  function baseName(path) {
    const parts = String(path || "").replace(/\/+$/, "").split("/");
    return parts[parts.length - 1] || null;
  }

  // rename > topic > CLI ai title > first prompt > directory
  function chatTitle(renamed, live, overview, cwd) {
    return renamed || (live != null ? live.title || live.topic : null) || (overview != null ? overview.title : null) || (live != null ? live.aiTitle : null)
      || (overview != null && overview.preview != null ? CC.util.firstLine(overview.preview.first || overview.preview.prompt || "", 80) : "") || baseName(cwd) || "Chat";
  }

  return { fromOverview: fromOverview, fromRuntime: fromRuntime, terminalState: terminalState, chatTitle: chatTitle, targetOf: targetOf, nowText: nowText };
})();
