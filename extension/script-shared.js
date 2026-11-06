// What the scripts in scripts/ share. A script is one file, so the build puts this in front of each.
const APP_ID = "claude-chat";

function say(text) {
  try {
    muxy.toast({ title: "Claude Chat", body: text });
  } catch (e) {
    console.warn(text);
  }
}

function why(e) {
  return e != null && e.message ? e.message : String(e);
}

function activeProject() {
  try {
    return muxy.projects.list().find(function (p) {
      return p.isActive === true;
    }) || null;
  } catch (e) {
    console.warn("projects not read: " + why(e));
    return null;
  }
}

// {result} from the probe, or {failure} when it couldn't run, such as a refused prompt or a server that's down.
function checkServer() {
  try {
    const res = muxy.exec({ shell: CC.probeCore.SHELL, timeoutMs: 20000 });
    if (res.timedOut === true || res.exitCode !== 0) {
      return { failure: res.timedOut === true ? "it took too long" : "exit " + res.exitCode };
    }
    return { result: CC.probeCore.parse(res.stdout) };
  } catch (e) {
    return { failure: why(e) };
  }
}

// Per project: a script can't tell which server a project is on, and storage is all it remembers with.
function sayOnce(text, project, missing) {
  const key = "toast:" + missing + ":" + (project != null ? project.id : "none");
  let said = false;
  try {
    said = muxy.storage.get(key) === true;
  } catch (e) {
    console.warn("storage not read: " + why(e));
  }
  if (said) {
    return;
  }
  say(text);
  try {
    muxy.storage.set(key, true);
  } catch (e) {
    console.warn("storage not written: " + why(e));
  }
}

function openTerminal() {
  try {
    muxy.tabs.open({ kind: "terminal" });
  } catch (e) {
    say("Couldn't open a terminal: " + why(e));
  }
}

// The one tab, in this computer's Home, whatever project this came from: a project first in the list is that Home, and tabs.open uses the current project.
// `singleton` focuses the tab if there is one, and replaces its data, which is how the page hears of the intent. The intent keeps the project it came from, which says its server.
function openApp(project, intent) {
  let home = null;
  try {
    home = muxy.projects.list()[0] || null;
    if (home != null && home.isActive !== true) {
      muxy.projects.switchTo(home.id);
    }
  } catch (e) {
    say("Couldn't open the app: " + why(e));
    return;
  }
  const data = { projectId: home != null ? home.id : null };
  if (intent != null) {
    data.intent = Object.assign({ id: Date.now() + "-" + Math.random().toString(36).slice(2), at: Date.now(), projectId: project != null ? project.id : null }, intent);
  }
  try {
    muxy.tabs.open({ kind: "extensionWebView", extension: { id: APP_ID, tabType: "app", singleton: true, data: data } });
  } catch (e) {
    say("Couldn't open the app: " + why(e));
  }
}

// This computer can stay without Claude Code: the app is its sidebar and terminals there, and says what's missing itself.
function localWithoutChats(result, project) {
  if (!CC.probeCore.noChats(result)) {
    return false;
  }
  try {
    return CC.probeCore.isLocal(result.ids, muxy.projects.list(), project) === true;
  } catch (e) {
    console.warn("projects not read: " + why(e));
    return false;
  }
}

// Whether this is the project holding the one tab, this computer's Home.
function isAppProject(project) {
  try {
    const home = muxy.projects.list()[0];
    return project != null && home != null && String(home.id) === String(project.id);
  } catch (e) {
    console.warn("projects not read: " + why(e));
    return false;
  }
}

// A chat where the server can run one, a plain terminal anywhere else. opts.sidebarOnLocal: the app also on this computer without chats.
// From the app's own project what this computer offers says nothing: the app holds every server, and it decides.
function appOrTerminal(project, intent, opts) {
  if (isAppProject(project)) {
    openApp(project, intent);
    return;
  }
  const check = checkServer();
  if (check.failure != null) {
    say("Claude Chat couldn't check this server, so this opens a terminal: " + check.failure);
    openTerminal();
    return;
  }
  if (opts != null && opts.sidebarOnLocal === true && localWithoutChats(check.result, project)) {
    openApp(project, null);
    return;
  }
  if (check.result.experience !== "chat") {
    const text = CC.probeCore.message(check.result);
    if (text != null) {
      sayOnce(text, project, check.result.missing);
    }
    openTerminal();
    return;
  }
  openApp(project, intent);
}
