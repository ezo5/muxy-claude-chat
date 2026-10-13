# Changelog

## 2.0.0 (2026-10-13)

V2 replaces the terminal-scraping V1 with a managed agent per chat.

- Chat tabs run `claude -p --input-format stream-json` through a per-session daemon on the server
  (`server/claude_chat/`): prompts, permission answers, interrupts and `/model`, `/effort` go over the CLI's control
  protocol instead of keystrokes; events are kept in `events.jsonl`, so a tab reloads its history without a transcript.
- Permission prompts, plan approval and `AskUserQuestion` come as `control_request`s and are answered from the card
  (`respond`), no screen parsing.
- Chat ⇄ terminal: a chat can continue in a terminal tab (`claude --resume <id>`) and mirrors it there; "Back to
  chat" ends the TUI and resumes the daemon. A running terminal Claude can still be adopted (`Ctrl+Opt+C`).
- Tab title follows the Haiku topic (claude-pane-title hook) in chat mode too: `events`/`wait` return it and wake
  on a change; order is rename > topic > CLI ai-title > first message.
- Review comments sent from the diff show as cards in the user bubble (file, line, code snippet, comment).
- Find in the diff view (Ctrl/Cmd+F or the search button): highlights matches in paths and code, unfolds collapsed
  files that contain the query.
- Settings dialog with sections on the left: General (default mode, auto-return, export) and Typography (chat
  font, size, line height, code font and size; live preview, shared by all chat tabs).
- Typography font selects list the fonts installed on the Mac (osascript on a Mac server, the open-file bridge's
  `fonts` request on a remote one); the chat font also applies to tool cards, questions and thinking.
- Notifications come from the daemon state (`list`), not from `muxy activity`.
- Installer: `host/install.sh` installs the server package (`setup.py --server`) on every target; `--statusline`
  stays optional; `setup.py --check` reports the package and the running daemons; `--uninstall` stops them.
- Removed: the terminal view and keys panel, `prompt-parse.js` / screen fixtures, the muxy-session binding
  (`terminal.js`, `termview.js`, `session.js`, `binding.js`, `composer/prompt.js`, `composer/keybar.js`), the side
  panel mode and the "Toggle Panel" command, reader ops `term` / `create` / `end` / `activity`.
- Parity on the daemon: streaming text and tool input, session title (`/rename`, `session_title_changed`), git
  branch chip (reader op `branch`), usage strip from `get_context_usage` / `rate_limit_event` / `result` (the
  statusline wrapper only fills a sparkline), `/model` and `/effort` pickers, `/resume` restarts the daemon, history
  after `/clear`, non-image attachments as `@<path>`, agents sidebar and review turns from the store, subagent tabs.
- Dev: store and mode tests (`dev/store.test.cjs`, `dev/modes.test.cjs`), server unit tests on recorded stream
  fixtures (`server/tests`), a mock muxy with a fake TUI (`dev/mock-muxy.js`), headless e2e scripts.
- Docs: `docs/ARCHITECTURE.md` rewritten for V2; V1-only notes moved to `docs/v1/`.
- Ported from the V1 UX work: effort row in the model picker and a composer effort button; Chat / Terminal
  segmented tabs in the header (replace the terminal icon, Open terminal and Back to chat); session token totals
  instead of cost in the usage strip; Claude Code's next-prompt suggestion as the composer placeholder (Tab or →
  accepts; the daemon turns on `promptSuggestions`); lightbox opens images at actual size when they fit; markdown
  links with `#L<line>` open as file:line; new review button icon.
- Find in the transcript (Ctrl/Cmd+F): match count, Enter / Shift+Enter between matches, folded steps unfold.
- Jump-to-latest button with a new-message badge; the view auto-follows while at the bottom.
- Turn footer with duration and output tokens, also for transcripts without `turn_duration`.
- Thinking shows as a collapsed row with a live one-line preview while it streams.
- Per-turn diff chip ("N files +a −b") that opens that turn in Review.
- Pinned task list above the composer from `TodoWrite` or `TaskCreate` / `TaskUpdate` / `TaskList`. CLI 2.1.295
  enables the task tools for current models only with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`; the daemon sets it unless
  the environment already does.
- Context ring in the composer with a "Compact now" popover.
- The send button turns into Stop while Claude works.
- Sessions with only background agents or commands left are idle: new prompts go out at once instead of queueing;
  follow-up turns the CLI starts for background notifications show as busy.
- Rename a chat by double-clicking its title.
- The `/resume` picker search also matches dates.
- Export the conversation as Markdown (`<cwd>/claude-chat-export-<date>.md`, from the settings popover).
- Drop files or paths on the composer to insert them as `@path` mentions.
- Rewind and edit on user bubbles: **Rewind to here** (conversation and code, conversation only, code only) over
  `rewind_conversation` / `rewind_files`; **Edit** rewinds to before the message and puts its text and images back
  in the composer. The daemon gives prompts uuids, enables SDK file checkpointing and records `daemon/rewound`; the
  reader shows only the active branch of rewound transcripts.
- Terminal mode and subagent tabs show the model chip (read-only) from the transcript's assistant entries.
- Subagent tabs of a chat-mode session show running / done / failed from the daemon's task events (`state.json`
  `tasks`) instead of "Stopped".
- Pins survive the switch between the chat (daemon events) and the transcript view (terminal mode, history): prompts
  are pinned by their CLI uuid, answers by their message id; earlier pins are rekeyed when shown.
- Queued prompts keep their full-size images across a reload (IndexedDB; muxy.storage only holds the previews).
- Repository layout reorganized.
- A prompt sent while a turn runs no longer leaves the tab busy forever: the CLI folds it into the running turn (one
  `result` for both), so the daemon drops prompts the CLI reported `started` (`command_lifecycle`) when the turn ends.

## Unreleased (0.4.0)

- Review view: expand hidden context like GitHub — above / below a hunk 20 lines per click, or all hidden lines, also
  at the start and end of a file; in unified and side by side, for every source; expanded lines can be commented.
- Open-file bridge: one LaunchAgent per server (`--open-bridge SSH=HOST:SRV`, repeatable) and a polling mode for
  sshfs mounts (`--bridge-poll`). Not verified on a Mac yet.
- README screenshots (chat, prompt card, review, terminal view) in `docs/screenshots/`, from the dev harness.
- Review view: pick what to review — uncommitted changes, Claude's edits in one turn, a commit, or a commit range;
  Shift+click a second line to comment on a line range; changed words inside a changed line are highlighted.
- Agents sidebar: subagents started by a subagent are listed (indented) under it; background commands
  (`run_in_background` Bash) show with their status and, on click, their last output lines; subagents of old
  transcripts (logged inline, without a `subagents/` folder) are found and open in their own tab too.
- Lightbox: zoom with the wheel, +/−, 0 (fit) and 1 (actual size), drag to pan, click the image to toggle fit and
  zoom; ←/→ and side buttons step through the images of one message.
- Pending (just sent) and queued messages show their image thumbnails instead of "1 image"; a click opens the
  image. The previews survive a reload of a queued message.
- Permission prompts: start typing on "Yes" or "No" and the card opens Claude's amend text (Tab) by itself, with what
  you typed already in it.
- Edit / Write permission prompts show the change as a diff (file, +/− counts) from Claude's pending tool call
  instead of the wrapped terminal lines. Edit cards in the chat show a real line diff before the result arrives too.
- Terminal view: the header terminal button (or Ctrl+backtick) shows the session's terminal in place of the chat, at
  full panel size, and you can type into it (keys, IME, paste); the same button goes back. Works for New Chat sessions
  without a terminal tab too; "Open terminal tab" still switches to the muxy tab when there is one.
- Slash commands in the chat: `/resume` without arguments opens a searchable picker of the project's earlier
  conversations (title, first prompt, age, branch) and resumes the pick with `/resume <id>`; command dialogs with a
  numbered list (`/model`, `/effort`, `/theme`, …) are answered from a dialog card (arrows, Enter, ←/→ for the effort
  line, Esc); `/clear` shows as a "New conversation" divider; other commands show as one card with their output.
- Review view (header button): the project's working-tree diff against `HEAD` incl. untracked files, collapsible
  per file with line numbers. Click a line to add a comment; comments stay as drafts (edit, delete, kept across
  reloads, count on the button) until **Send comments** sends them all to Claude as one message (queued while
  Claude works).
- Review view: changed-files sidebar like IntelliJ's Changes (status letter and color, directory, +/− lines, draft
  comment badge, totals; click or ↑/↓ jumps to a file; drag to resize, overlay on narrow panels) and a Unified /
  Side by side toggle (remembered; side by side pairs removed and added lines, comments work on both sides).
- Notifications (finished / needs attention) for chats without a terminal pane, e.g. New Chat sessions: a background
  script follows `muxy activity list` and notifies unless that chat tab is focused. Sessions with a terminal pane keep
  muxy's own notifications (no duplicates).
- Chat tabs long-poll the server (reader op `wait`) instead of polling every 0.9–1.6 s: updates show within ~150 ms
  and idle tabs cost one waiting process instead of a python start every 1.6 s. The background script also kicks a
  tab when its session's agent state changes.
- Fixed: agents sidebar showed an agent resumed by SendMessage as running forever.
- Fixed: the panel sometimes stayed blank (no header icons, no composer). Muxy fails webview asset requests beyond
  32 in flight; the panel now loads bundles (`build.py`), and failed loads show an error instead of a blank page.
- Tab title follows the conversation: `/rename` title, then the topic kept by the optional `claude-pane-title` hook,
  then Claude's one-off ai-title.
- Startup dialogs without numbered options (folder trust on first run in a directory) are shown as a prompt card
  while Claude isn't running yet, so a new chat no longer just says "Not running".
- Repo split out of a private setup; installer and docs for anyone.
- Header and usage strip show model with effort (`Opus 5.5 [medium]`) and the git branch.
- Error toasts have a copy button, stay 8 s and are appended to the server error log.
- Colors follow the muxy theme: errors use the theme red (`diffRemove`), success green, info cyan; failed tools,
  failed step counts, error notices and error toasts are red; syntax highlighting and permission-mode chips use theme
  colors.
- Usage strip under the composer (context, 5-hour limit, cost) with a detail card and 24 h sparkline.
- Open file paths from the chat in Zed, IntelliJ or Finder, or copy them.
- Pinned messages in a left sidebar.
- Agents sidebar on the right (header button with a running-count badge): subagents of the current session with
  status (running / done / failed / stopped), elapsed time and last activity. While the main session is idle but
  background agents still run, the status pill shows "Ready · N agents" and the tab dot stays busy.
- Agents sidebar lists only this session's subagents (the "Other sessions" list is gone). Click opens the
  subagent's transcript in its own read-only chat tab with live status (Working / Done / failed / stopped) and the
  final report as a message; a second click switches to that tab.
- Fixed: `AskUserQuestion` with option previews could not be answered from the card (that prompt ignores number
  keys; the card now moves with arrows and presses Enter). The card shows the preview of the selected option, and
  the preview box no longer leaks into option labels.
- New Chat shows a notification when it fails instead of failing silently; startup errors of the chat page are shown
  in a red box (muxy webviews have no devtools).
- Tool calls of finished turns fold into one "N steps" line.
- Composer pinned to the bottom; typing no longer shifts the chat.
- Fixed: multi-line messages were pasted but not submitted (input-clear burst now sent in small chunks).
- Sending a message shows a small spinner in the bubble instead of "Sending…" / "Sent".
- Fixed: false "Sent" when the input box was not found on screen.
- Fixed: pasted text showed the `<pasted_content>` wrapper and leading blank lines in user bubbles.
- Light theme: follows muxy's `colorScheme`; code, diff and terminal backgrounds, shadows and scrollbars derive from
  the theme, and syntax colors get darker ink on light backgrounds.
- Attached images show as thumbnails in user bubbles; click opens a lightbox. Images load on demand, not with the poll.
- Tab status dots use the muxy theme colors (nearest of 216 pre-generated dots; `setIcon` only takes SVG files).
- Permission prompts, plan approval and `AskUserQuestion` are answered from a card above the composer: options as
  buttons, keyboard-driven (↑/↓, 1–9, Space, Enter, Tab, Esc, typing for "Other" and amend notes), sent to the
  terminal as Claude Code's own keys and kept in sync with the terminal screen. The ⌨ panel stays as the fallback.

## 0.3.0

- One chat tab is bound to one muxy server session, kept across restarts.
- New Chat (`Cmd+Shift+N`) creates a server session and starts `claude` in it; End session button.
- Tab icon shows the session status as a colored dot.

## 0.2.0

- Full chat UI: markdown, tool cards with diffs, thinking, todos, prompt queue, slash commands, `@` file mentions,
  image attachments, input history, drafts.

## 0.1.0

- Proof of concept: transcript JSONL rendered as a chat, prompts typed into the terminal.
