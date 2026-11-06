# Installing claude-chat

claude-chat 3.0 is one Muxy 2.x extension. A marketplace install or a Load Unpacked is all it needs:

- **Extension** (`extension/`, built into `extension/dist/`): the app. One tab per server.
- **Server package** (`server/claude_chat/`): travels inside the extension's bundle. The app writes it to
  `~/.local/share/claude-chat/<version>/` the first time it opens on a server. There's nothing to copy or run there.

Optional extras, never required, are set up from a Mac by `host/install.sh`:

- **Open-file bridge** (`host/open-bridge.zsh`): a LaunchAgent that lets a chat on a remote server open files in Zed, IntelliJ or
  Finder and links in the default browser on the Mac. Without it, remote paths open in the file pane or get copied.
- **Statusline wrapper** (`server/statusline.py`): adds data for terminal-mode sessions.

## Requirements

**Muxy** 2.x on macOS 14+ or Linux. Remote servers need 2.0.0-beta.1106 or newer.

**Server** (the Mac for local projects, or a remote Linux box)
- A POSIX shell and `python3` 3.9 or newer, stdlib only. On a Mac, `/usr/bin/python3` counts once the Command Line Tools are
  installed (`xcode-select --install`).
- Claude Code (`claude`) on the login shell's `PATH`, or named as `claudeBin` in `~/.config/claude-chat/config.json`.
  Below the minimum tested version the app opens a terminal and says so once.
- Optional: the `muxy` CLI on `PATH` or in `~/.local/bin`. It lists which projects belong to the server, adds projects there
  and tells apart several Claudes in one directory when adopting a terminal.

A server without Claude Code: Local opens as the sidebar with projects and terminals, without chats; a remote gets a plain Muxy
terminal from the icon, and its list when clicked in the sidebar. Nothing installs, nothing asks.

## Quick start

From the marketplace: Settings → Extensions → Browse. Or from a checkout:

```bash
git clone https://github.com/ezo5/muxy-claude-chat.git ~/src/claude-chat
python3 ~/src/claude-chat/extension/build.py --no-sample
```

Then **Settings → Extensions → Load Unpacked…** → `~/src/claude-chat/extension` (Muxy loads its `dist/`) → enable **claude-chat**.

Open it with the top bar icon or palette → **Claude Chat: New Chat** (`Cmd+Shift+T`). Focus a terminal where `claude` runs and press
`Ctrl+Opt+C` to bring it into the app.

Tip, not required: Muxy Settings → Appearance, layout Tab Focused with the built-in sidebar collapsed gives the app the whole window.
A hidden terminal tab has no app navigation; `Cmd+E` comes back to the app.

## Shortcuts

Change them in Muxy Settings → Keyboard.

| keys | action |
| --- | --- |
| `Cmd+Shift+T` | New Chat |
| `Ctrl+Opt+C` | Adopt the focused terminal |
| `Cmd+Shift+]`, `Cmd+Shift+[` | Next, previous chat |
| `Cmd+E` | Last used chat, also back from a terminal |
| `Cmd+Shift+1…9` | Chat N in the sidebar's order |

On Linux, Muxy reads `cmd` as Super, and `Ctrl+Shift+T` stays Muxy's new tab.

## Updating from 2.x

The id stays `claude-chat`, so the registration, your remembered answers and Muxy's storage stay. Start from a state with nothing
pending in 2.x, as queued messages, per-tab Review comments and chats in terminal mode are not carried over.

1. Get the new version and build it (above). A registration of `<checkout>/extension` keeps working.
2. If `settings.toml` has `"extension.claude-chat.<command>" = ""` lines in `[keymap]`, delete them: they take that command's shortcut away.
3. Settings → Extensions → claude-chat → **Reload**, or restart Muxy.
4. If Settings → Appearance has Claude Chat as the active sidebar: the built-in sidebar shows instead, as 3.0 has none of its own.

Then:
- Running chats and stopped ones stay on the server and show in the sidebar with their history. Daemons aren't restarted.
- On its first run on each server the app copies 2.x's settings there (typography, notifications, sidebar options, default mode,
  Review options, project order) and that server's pins and drafts. A value already set stays. 2.x's storage isn't changed.
- 2.x's open tabs come back saying where their chat went, with a button. Close them when you like: Muxy doesn't let a page close its tab.
- Shortcuts: New Chat moves from `Cmd+Shift+N` to `Cmd+Shift+T`.
- `~/.local/share/claude-chat/claude_chat/`, 2.x's package, stays until you remove it. Old running daemons use it until they stop.

## What the installer does

`host/install.sh` is for the extras, and for registering from a checkout. It runs on a Mac and needs only what macOS ships, plus `python3`
if `extension/dist` isn't built yet.

```
host/install.sh [--local] [--server SSH]... [--statusline] [--open-bridge [SSH=]HOST:SERVER]... [--bridge-poll]
                [--check | --uninstall] [--dry-run] [--app PATH] [--profile DIR] [--no-register]
```

| Flag | Effect |
| --- | --- |
| `--local` | Target: this Mac, for `--statusline` and `--check`. |
| `--server SSH` | Target: a remote server, by the `ssh` value of its `[[servers]]` entry. Repeatable. Runs `ssh SSH python3 - … < server/setup.py`; nothing is copied there first. |
| `--statusline` | Installs the statusline wrapper on each target. |
| `--open-bridge [SSH=]HOST:SERVER` | Sets up the open-file bridge for a remote server (see below). Needs `--server`. Repeatable, one per server. |
| `--bridge-poll` | The bridges poll their request folder every second instead of being started by launchd. Use it for sshfs. |
| `--check` | Diagnoses only: Muxy version, registration, build, leftover keymap lines, `setup.py --check` on each target (python, `claude`, package, running daemons), bridge state. |
| `--uninstall` | Removes the registration and the LaunchAgent. With targets, also runs `setup.py --uninstall` there (stops the daemons, removes the packages, the statusline wrapper and the config). |
| `--dry-run`, `-n` | Prints every change instead of making it. Read-only checks still run. |
| `--app PATH`, `--profile DIR` | Muxy app bundle and profile folder, if not the usual ones. |
| `--no-register` | Skips the extension registration. |

The installer is idempotent, and exits with status 1 if it printed warnings.

### Extension registration

Muxy keeps unpacked extension folders in the profile folder, not in `settings.toml`:

- `extension-folders.json`: `{"claude-chat": "/absolute/path/to/extension"}`.
- `extension-enabled.json`: `["claude-chat", …]`.

Muxy reads both at startup and rewrites them from memory when you change extensions, so the installer edits them only while Muxy isn't
running. The previous files are backed up to `~/Library/Application Support/claude-chat/backup/<time>/`. An entry for the preview id
`claude-chat-next` is removed. If Muxy is running, register by hand as in Quick start.

## Optional features

### Usage (`--statusline`)

In chat mode the context ring and the 5-hour bar are fed by the daemon, so this adds nothing there; it only adds data for terminal-mode
sessions. `--statusline` installs a small wrapper:

- `~/.local/share/claude-chat/statusline.py` becomes `statusLine.command` in `~/.claude/settings.json`. Other
  settings are kept, and the first change backs the file up as `settings.json.claude-chat-bak`.
- Your existing statusline command is not replaced. The wrapper runs it with the same input and prints its output.
- The wrapper saves the data under `~/.cache/claude-chat/` on the server.

### Open-file bridge (`--open-bridge [SSH=]HOST:SERVER`)

Clicking a file path in a chat opens it in Zed, IntelliJ or Finder. On a local Mac project, the server opens the
file directly. A remote server cannot start Mac apps, so the bridge carries the request. It needs a folder that both
sides see: a VM's shared folder, an sshfs mount, or similar. `HOST` is the Mac path and `SERVER` is the same folder
on the server, for example `~/vm-share:/home/me`.

How it works:
1. On the server, the package writes `SERVER/.claude-chat-bridge/req/<id>.json`:
   `{"id", "path", "line", "app", "root", "ts"}`.
2. launchd starts `~/Library/Application Support/claude-chat/open-bridge.zsh` when that folder changes
   (`WatchPaths`). It also runs every 60 s as a safety net, and it keeps polling for 20 s after the last request.
   With `--bridge-poll` the script runs all the time instead (`KeepAlive`, `--poll 1`) and lists the folder every second.
3. The script checks the request and maps the server path to the Mac. It accepts only paths under `SERVER`, with no `.` or `..`
   segments. The request data goes to commands as arguments, never through a shell string.
4. It opens the file: `zed path:line` or `open -a Zed`; `idea --line N path` or `open -b com.jetbrains.intellij`; Finder reveals it with AppleScript.
5. It writes `HOST/.claude-chat-bridge/res/<id>.json` and deletes the request. The server waits up to 5 s for it. Requests older
   than 60 s are dropped unopened.

Each server gets its own bridge (label and log named after the `--server` value):
- LaunchAgent: `~/Library/LaunchAgents/dev.claude-chat.open-bridge.devbox.plist`.
- Script: `~/Library/Application Support/claude-chat/open-bridge.zsh`, shared.
- Log: `~/Library/Logs/claude-chat-open-bridge.devbox.log`.
- On the server: `openBridge: {dir, root}` in `~/.config/claude-chat/config.json`.

Several servers, over sshfs:
```bash
host/install.sh --server devbox --server gpu --bridge-poll \
  --open-bridge devbox=~/mnt/devbox:/home/me --open-bridge gpu=~/mnt/gpu:/srv/work
```
Mount with a short directory cache, e.g. `sshfs devbox:/home/me ~/mnt/devbox -o dir_cache=no`. Polling over sshfs is not verified yet.

After installing, the installer sends a test request and waits for the answer.


### Notification sounds

Muxy plays one default sound for every notification. claude-chat plays its own: Settings → Notifications picks a sound or Off for
"Needs your attention" and "Finished working", the volume, whether a focused chat also sounds, and an optional banner.

- Turn Muxy's own notifications off in **System Settings → Notifications → Muxy**, or you hear two sounds.
- A local Mac project plays with `afplay`, a remote server through the open-file bridge. Without either the page plays a short tone.
- After a Muxy restart there are no sounds until the app's tab has been shown once: Muxy creates a page when its tab is first visible.

## First use: permission prompts

Muxy asks before an extension does something sensitive. Allow these and choose to remember them:
- running one shell line, the server check (no Python is started blindly);
- running `python3 -c …` on a server, once per distinct Python path;
- opening a terminal with a command, when a chat continues in a terminal, once per command;
- deleting a project, when you do that from the sidebar.

Remembered answers belong to the extension id and the exact command: updating from 2.x keeps those for `python3`, but asks for the new ones.

## Update

```bash
cd ~/src/claude-chat && git pull && python3 extension/build.py --no-sample
```

Then Settings → Extensions → claude-chat → **Reload**. A new version installs its server package beside the old one, without touching
running daemons, and removes old versions when nothing uses them.

## Uninstall

Quit Muxy first, then:
```bash
host/install.sh --uninstall --server devbox     # or --local, or no target for the Mac side only
```

This removes the registration, the LaunchAgent, its script and the Mac's `.claude-chat-bridge` folder. On each target, `setup.py --uninstall`
stops the daemons, restores your previous statusline command and removes the packages and the config. Kept: the checkout, `~/.cache/claude-chat/`
and `~/.config/claude-chat/kv/` on the server, and the extension's storage and permission answers in the Muxy profile.

## Troubleshooting

- **Diagnostics**: `host/install.sh --check --server <ssh>` (or `--local`). It changes nothing.
- **The extension doesn't show up**: Settings → Extensions lists load errors. `tab type 'app' entry 'index.html' was not found`: `extension/dist` isn't
  built. `claude-chat-next: duplicate or changed package name`: an old preview registration, remove it there.
- **Old code after a change**: Reload, sometimes twice.
- **A shortcut does nothing**: an empty `extension.claude-chat.*` line in `settings.toml` `[keymap]`, or another binding of that chord (Settings → Keyboard).
- **A chat doesn't start**: its log is `~/.cache/claude-chat/sessions/<sessionId>/daemon.log` on the server. `claude` not found: set `claudeBin` in the config.
- **Adopting a terminal finds the wrong Claude**: with several Claudes in one directory the newest one wins on a Mac;
  on Linux the `muxy` CLI tells them apart.
- **Open in Zed/IntelliJ/Finder fails**:
  - "bridge not responding": check that the agent is loaded
    (`launchctl print gui/$UID/dev.claude-chat.open-bridge.<server>`), then read
    `~/Library/Logs/claude-chat-open-bridge.<server>.log`.
  - "not found on the Mac": `HOST` and `SERVER` do not point at the same folder.
  - With sshfs, launchd may not notice files that the server writes: install with `--bridge-poll`.
- **Server errors**: the package logs them in `~/.cache/claude-chat/errors.log`.
