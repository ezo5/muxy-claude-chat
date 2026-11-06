// Top bar icon and palette command. From a terminal running Claude it brings that Claude into the app, as the top bar always did.

function focusedClaudePane() {
  try {
    const pane = muxy.panes.list().find(function (p) {
      return p.isFocused === true;
    });
    if (pane == null) {
      return null;
    }
    const agent = muxy.agents.list().find(function (a) {
      return String(a.paneID) === String(pane.id) && String(a.providerID).toLowerCase() === "claude";
    });
    return agent != null ? String(pane.id) : null;
  } catch (e) {
    console.warn("focused terminal not read: " + why(e));
    return null;
  }
}

const claudePane = focusedClaudePane();
appOrTerminal(activeProject(), claudePane != null ? { kind: "adopt", paneId: claudePane } : null, { sidebarOnLocal: true });
