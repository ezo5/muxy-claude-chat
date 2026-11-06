# Claude Chat

Chat with Claude Code inside Muxy: a chats sidebar, conversations side by side and a details rail, all in one tab. A server needs
a POSIX shell, Python 3.9+ and Claude Code. Without Claude Code a project simply gets a Muxy terminal.

Build with `python3 build.py`. It writes `dist/`, the folder Muxy loads.

## Bundled third-party code

`js/conversation/vendor-marked.js` (marked 15.0.12, MIT) and `js/conversation/vendor-highlight.js` (highlight.js 11.11.1, BSD-3-Clause) are the projects' own browser
builds, unchanged; the licenses are in `js/conversation/vendor-LICENSES.txt`. They ship as published, highlight.js minified, so they can be compared with the releases; nothing of ours is minified.

## Old tabs

Tab type `chat` exists only for tabs that an earlier version of this extension left open. Muxy restores those, and `moved.html` says where their chat went.

## Permissions

| Permission | Why |
| --- | --- |
| `commands:exec` | Talks to the chat server on the project's server, the only channel a page has |
| `commands:run-script` | The top bar icon and the palette command |
| `tabs:write` | Opens this tab, terminal tabs and browser tabs, and switches to them |
| `panes:read` | Lists terminals for the sidebar and reads a terminal's screen for chat and terminal handover |
| `panes:write` | Closes a terminal when a chat returns from it |
| `projects:read`, `projects:write`, `projects:delete` | Lists projects in the sidebar, adds and removes them from its menu |
| `agents:read` | Shows the state of agents running in terminals |
| `notifications:write` | Tells you when a chat needs you or has finished |
| `files:read` | Only the online dot of each remote server: a check of its folder over the connection Muxy already holds |
| `storage:read`, `storage:write` | Remembers that the top bar icon has already told you once what a server is missing, which servers it has seen with their chat rows, and the layout on a server without chats; reads what an earlier version saved, once |
