try {
  const project = muxy.projects.list().find(p => p.isActive);
  if (project == null) {
    muxy.notifications.notify({ title: "Claude Chat", body: "No active project" });
  } else {
    muxy.tabs.open({
      kind: "extensionWebView",
      extension: { id: "claude-chat", tabType: "chat", data: { newSession: true, projectId: project.id, directory: project.path } },
    });
  }
} catch (e) {
  muxy.notifications.notify({ title: "Claude Chat: New Chat failed", body: String(e && e.message ? e.message : e) });
}
