// New Chat, also with no page yet: the same choice as the top bar icon, and the page starts the chat. `shortcut`: the page prefers the project selected in its sidebar, which a script can't see.

const project = activeProject();
appOrTerminal(project, { kind: "new", cwd: project != null ? project.path : null, shortcut: true });
