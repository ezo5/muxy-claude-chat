const pane = muxy.panes.list().find(p => p.isFocused);
if (pane == null) {
  muxy.notifications.notify({ title: "Claude Chat", body: "Focus the terminal pane with Claude first" });
} else {
  const tab = muxy.tabs.list().find(t => t.isActive);
  muxy.tabs.open({
    kind: "extensionWebView",
    extension: {
      id: "claude-chat",
      tabType: "chat",
      data: { paneId: pane.id, paneTitle: pane.title, terminalTabId: tab != null && tab.kind === "terminal" ? tab.id : null },
    },
  });
}
