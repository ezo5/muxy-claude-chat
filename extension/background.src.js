// Built into background.js (with CLI_SRC) by build.py. exec is synchronous here and blocks this thread.
// Polls the daemon state of the sessions open in chat tabs (`list` op) and notifies on waiting / finished transitions.
const POLL_MS = 4000;
const chats = new Map();
let states = {};
let backoff = 0;

function cli(payload) {
  const res = muxy.exec(["python3", "-c", CLI_SRC], { stdin: JSON.stringify(payload), timeoutMs: 30000 });
  if (res.exitCode !== 0) {
    throw new Error("cli " + payload.op + " failed: " + (res.stderr || "").trim().split("\n").pop());
  }
  return JSON.parse(res.stdout);
}

function chatFor(sid) {
  let found = null;
  chats.forEach(function (chat) {
    if (chat.sid === sid && (found == null || chat.focused)) {
      found = chat;
    }
  });
  return found;
}

function label(chat, session) {
  if (chat.title != null && chat.title !== "") {
    return chat.title;
  }
  return (session.cwd || "").split("/").pop() || "Claude";
}

function step() {
  if (chats.size === 0) {
    states = {};
    return;
  }
  const next = {};
  (cli({ op: "list" }).sessions || []).forEach(function (s) {
    const chat = chatFor(s.sessionId);
    if (chat == null) {
      return;
    }
    next[s.sessionId] = s.status;
    const prev = states[s.sessionId];
    if (prev == null || prev === s.status) {
      return;
    }
    try {
      muxy.events.emit("extension.activity", { sid: s.sessionId, state: s.status });
    } catch (e) {
      console.warn("activity event failed: " + e.message);
    }
    if (chat.focused) {
      return;
    }
    if (s.status === "waiting") {
      muxy.notifications.notify({ title: label(chat, s), body: "Needs your attention" });
    } else if (prev === "busy" && s.status === "idle") {
      muxy.notifications.notify({ title: label(chat, s), body: "Finished working" });
    }
  });
  states = next;
}

function loop() {
  let delay = POLL_MS;
  try {
    step();
    backoff = 0;
  } catch (e) {
    backoff = Math.min(backoff * 2 || 2000, 30000);
    delay = backoff;
    console.warn("daemon poll failed: " + (e && e.message ? e.message : e));
  }
  setTimeout(loop, delay);
}

muxy.events.subscribe("extension.chat", function (msg) {
  if (msg == null || msg.tab == null) {
    return;
  }
  // terminal mode: the TUI is in a visible pane and muxy notifies itself
  if (msg.sid == null || msg.mode === "terminal") {
    chats.delete(String(msg.tab));
    return;
  }
  chats.set(String(msg.tab), { sid: String(msg.sid), title: msg.title || null, focused: msg.focused === true });
});

muxy.events.subscribe("tab.closed", function (tab) {
  if (tab != null && tab.tabInstanceID != null) {
    chats.delete(String(tab.tabInstanceID));
  }
});

// TEMPORARY: muxy 2.1.0 keeps a page tab's title only in its live webview and creates webviews for visible tabs
// only, so after a restart chat tabs show "Claude Chat" until opened. Once per project and run a modal loader
// (warmup/) opens them behind it. Replace with a proper fix once muxy persists tabs.setTitle or can load hidden tabs.
const warmed = new Set();
let warming = 0;

function warm(project) {
  if ((project != null && warmed.has(project)) || Date.now() - warming < 30000) {
    return;
  }
  warming = Date.now();
  try {
    Promise.resolve(muxy.modal.openWebview({ entry: "warmup/warmup.html", width: 120, height: 120, dismissOnOutsideClick: false })).catch(function (e) {
      console.warn("warmup failed: " + (e && e.message ? e.message : e));
    });
  } catch (e) {
    console.warn("warmup failed: " + e.message);
  }
}

muxy.events.subscribe("extension.warmup", function (msg) {
  warming = 0;
  if (msg != null && msg.project != null) {
    warmed.add(String(msg.project));
  }
});

muxy.events.subscribe("project.switched", function (e) {
  if (e != null && e.projectID != null) {
    warm(String(e.projectID));
  }
});

setTimeout(loop, 1000);
setTimeout(function () {
  warm(null);
}, 1500);
