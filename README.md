# claude-chat

A chat app for Claude Code in [Muxy](https://github.com/muxy-app/muxy) 2.x. One Muxy tab holds all of it: a chats
sidebar, conversations side by side and a details rail. Each chat runs its own headless `claude -p` through a small daemon
on the project's server (the Mac or a remote Linux box), so your CLI setup, hooks and permissions stay as they are; at any
time a conversation can continue in a real terminal tab and come back.

<p>
  <img src="extension/assets/screenshot-1.png" alt="The app tab: chats sidebar, a conversation with folded tool steps, details rail" width="98%">
</p>

## Features

- **One tab**: sidebar, chats and rail on one page, one tab per server. Up to three panes side by side: chats, Review, file,
  plan, tasks, pins and subagent transcripts.
- **Sidebar**: server → project → chat, grouped by project or by state (Needs you, Working, Recent), with filters, drag and
  drop, and answers to permission requests right on the row. Other servers' chats show under their server; a click goes to
  that server's tab.
- **Transcript**: streaming answers, Markdown with tables and highlighted code, images, compaction dividers, older
  history on scroll. Tool work folds into one summary line, then intent rows, then detail in place. View modes Normal,
  Thinking and Verbose. Light and dark follow the Muxy theme.
- **Composer**: queue while Claude works, `/` command and skill completion, `@` files, prompt history, pasted or dropped
  images and files, interrupt, permission mode, model, effort, context ring and 5-hour usage bar.
- **Questions in the flow**: permission cards with the edit's diff, plan approval and Claude's multiple-choice questions,
  fully keyboard-driven, answered over Claude Code's control protocol.
- **Slash commands** with native cards: `/resume`, `/model`, `/effort`, `/usage`, `/status`, `/mcp`, `/agents`, `/hooks`,
  `/permissions`, `/memory`, `/rewind`, `/btw` and more.
- **Chat ⇄ terminal**: continue a conversation in a native Muxy terminal (`claude --resume`) while the chat mirrors it, and
  take it back. A Claude already running in a terminal can be adopted (`Ctrl+Opt+C`).
- **Review**: uncommitted diff, one turn's edits, a commit or a range; viewed marks, line comments sent to Claude as one
  message, side by side mode and word highlights.
- **Rail**: environment, tasks, context by category, changes, agents.
- **Notifications**: sounds when a chat needs you or has finished, optional banners.
- **Works anywhere**: a server needs a POSIX shell, Python 3.9+ and Claude Code. Without Claude Code, Local shows projects
  and terminals in the same app, and a remote gets a plain Muxy terminal. Nothing else to install.

## Install

Either from the Muxy marketplace, or from this repository:

```bash
git clone https://github.com/ezo5/muxy-claude-chat.git ~/src/claude-chat
python3 ~/src/claude-chat/extension/build.py --no-sample
```

Then in Muxy: **Settings → Extensions → Load Unpacked…**, choose `~/src/claude-chat/extension`, and enable **claude-chat**.

Open it with the top bar icon or **New Chat** (`Cmd+Shift+T`), and allow and remember the prompts on first use. The app
installs its small server package itself, on each server, when it first opens there. Nothing has to be copied or run there.

Optional extras (opening files on the Mac from a remote server, the statusline wrapper) are in `host/install.sh`; see
[docs/INSTALL.md](docs/INSTALL.md), which also covers requirements, shortcuts, updating from 2.x and uninstalling.

## Docs

- [docs/INSTALL.md](docs/INSTALL.md): installation, options and troubleshooting.
- [CHANGELOG.md](CHANGELOG.md).

## License

MIT, see [LICENSE](LICENSE).
