# Installing claude-chat

claude-chat is a Muxy 2.x extension. It has three parts:

- **Extension** (`extension/`): the chat UI. Muxy on the Mac loads it from this checkout as an unpacked extension.
- **Server side** (`server/setup.py --server`): the agent host, a small Python package installed under
  `~/.local/share/claude-chat/` on the computer where Claude Code runs. That computer is the Mac itself (a local
  project) or a Linux box that Muxy reaches over SSH (a remote project). It runs `claude -p` for every chat tab.
- **Open-file bridge** (`host/open-bridge.zsh`): an optional LaunchAgent. It lets a chat on a remote server open
  files in Zed, IntelliJ or Finder and links in the default browser on the Mac.

`host/install.sh` sets up all three from the Mac. It needs only what macOS ships: zsh, `plutil`, `osascript` and
`launchctl`. It does not need Homebrew, node or Python on the Mac.

## Requirements

**Mac**
- Muxy 2.x. For remote servers you need 2.0.0-beta.1106 or newer, the first version with `[[servers]]` SSH remotes.
  The installer reads the version from the app's `Info.plist` and warns if it is older.
- macOS 14 or newer (Muxy 2.x's minimum).

**Server** (the Mac for local projects, or the remote Linux box)
- Claude Code CLI (`claude`) on `PATH`, in `~/.local/bin`, or named as `claudeBin` in
  `~/.config/claude-chat/config.json`.
- `python3` 3.9 or newer, stdlib only. The extension runs the reader and the agent host CLI with `python3`.
  - On a Mac, `/usr/bin/python3` works once the Command Line Tools are installed (`xcode-select --install`).
- Optional: the `muxy` CLI on `PATH` or in `~/.local/bin`, only for adopting a terminal when several Claudes run in
  the same directory.

## Quick start

Clone the repo somewhere the Mac can read it, then run the installer on the Mac. The paths below assume a clone at
`~/src/claude-chat`.

Claude runs on the Mac:
```bash
git clone https://github.com/ezo5/muxy-claude-chat.git ~/src/claude-chat
~/src/claude-chat/host/install.sh --local --statusline
```

Claude runs on a remote server that Muxy knows as `devbox` (its `ssh` value in `[[servers]]`):
```bash
~/src/claude-chat/host/install.sh --server devbox --statusline
```

Quit Muxy (Cmd+Q) before you run it, so the installer can register the extension itself. If Muxy is running, the
installer prints the manual steps instead and still does the rest.

Then start Muxy and open a chat:
- Palette → **Claude Chat: New Chat** (`Cmd+Shift+N`): a chat on the agent host in the active project.
- Or focus a terminal where `claude` runs and press `Ctrl+Opt+C` (or click the chat icon in the top bar): the chat
  mirrors that terminal; "Back to chat" takes the conversation over.

### Example: Mac with a Linux VM

Any VM works (Lima, UTM, OrbStack, Parallels, …) as long as Muxy reaches it over SSH. Say Muxy knows the VM as
`devbox` and the Mac folder `~/vm-share` is mounted in the VM as `/home/me` (a shared folder or sshfs):

```bash
~/src/claude-chat/host/install.sh --server devbox --statusline --open-bridge ~/vm-share:/home/me
```

This registers `~/src/claude-chat/extension` as an unpacked extension, installs the agent host in the VM over SSH,
and installs a LaunchAgent that opens `/home/me/...` paths from the chat as `~/vm-share/...` on the Mac. Without a
shared folder, leave out `--open-bridge`; only opening files on the Mac is lost.


## What the installer does

```
host/install.sh [--local] [--server SSH]... [--statusline] [--open-bridge [SSH=]HOST:SERVER]... [--bridge-poll]
                [--check | --uninstall] [--dry-run] [--app PATH] [--profile DIR] [--no-register]
```

| Flag | Effect |
| --- | --- |
| `--local` | Target: Claude runs on this Mac. Runs `server/setup.py --server` with the Mac's `python3`. |
| `--server SSH` | Target: a remote server, by the `ssh` value of its `[[servers]]` entry (an `~/.ssh/config` alias, `user@host` or `ssh://user@host:port`). Repeatable. Runs `ssh SSH python3 - … < server/setup.py`; nothing is copied to the server first. |
| `--statusline` | Turns on the usage strip (see below) on each target. |
| `--open-bridge [SSH=]HOST:SERVER` | Sets up the open-file bridge for a remote server (see below). Needs `--server`. Repeatable, one bridge per server; with several `--server`, `SSH=` says which one. |
| `--bridge-poll` | The bridges poll their request folder every second instead of being started by launchd. Use it for sshfs. |
| `--check` | Diagnoses only: Muxy version, registration, `setup.py --check` on each target (python, `claude`, package state, running chat daemons), bridge state and its last log lines. |
| `--uninstall` | Removes the registration and the LaunchAgent. With targets, also runs `setup.py --uninstall` there (stops the daemons, removes the package, the statusline wrapper and the config). |
| `--dry-run`, `-n` | Prints every change instead of making it. Read-only checks, including `setup.py --check` over SSH, still run. |
| `--app PATH` | Muxy app bundle, if it is not `/Applications/Muxy Beta.app` or `/Applications/Muxy.app` (or under `~/Applications`). |
| `--profile DIR` | Muxy profile folder. The default is `~/Library/Application Support/Muxy Beta` for a beta, `…/Muxy 2` for a stable 2.x, or `$MUXY_DIR` if set. |
| `--no-register` | Skips the extension registration. |

The installer is idempotent; run it again after changing flags. It exits with status 1 if it printed warnings.

With no target, it lists the servers in Muxy's `settings.toml` (`name -> ssh`) to help you pick one.

For each target it first runs `setup.py --check` and prints a short summary: Python version, the `claude` path, the
package state, running daemons, the statusline state and the claude-chat config. Then it runs `setup.py --server`
plus the options you chose. The package sources are embedded in `setup.py` (`server/build.py`), so nothing else is
copied to the server; run the installer again after `git pull` when `server/` changed (`--check` says
`current=false` until you do).

### Extension registration

Muxy 2.x keeps unpacked extension folders in the profile folder, not in `settings.toml`:

- `extension-folders.json`: `{"claude-chat": "/absolute/path/to/extension"}`.
- `extension-enabled.json`: `["claude-chat", …]`.

The app reads both files at startup and rewrites them from memory when you change extensions. So the installer edits
them only while Muxy is not running (`pgrep -x muxy-app`). The previous files are backed up to
`~/Library/Application Support/claude-chat/backup/<time>/`. If an older claude-chat folder was registered, the entry
is pointed at this checkout.

If Muxy is running, register by hand: **Settings → Extensions → Load Unpacked…** → choose `<checkout>/extension`, then
enable **claude-chat**.

## Optional features

### Usage strip (`--statusline`)

The strip under the composer shows context use, the 5-hour limit and cost, with a detail card and a 24 h sparkline.
It reads what Claude Code passes to its statusline command, so `--statusline` installs a small wrapper:

- `~/.local/share/claude-chat/statusline.py` becomes `statusLine.command` in `~/.claude/settings.json`. Other
  settings are kept, and the first change backs the file up as `settings.json.claude-chat-bak`.
- Your existing statusline command is not replaced. The wrapper runs it with the same input and prints its output,
  so the terminal statusline looks as before. Without one, it prints `model · ctx N%`.
- The wrapper saves the data under `~/.cache/claude-chat/` on the server.

In chat mode the strip is fed by the daemon (`-p` runs no statusline), so the wrapper adds nothing there; it only
adds data (and the 24 h sparkline) for terminal-mode / TUI sessions. Without `--statusline` the chat works; terminal
mode just has less data in the strip.

### Open-file bridge (`--open-bridge [SSH=]HOST:SERVER`)

Clicking a file path in a chat opens it in Zed, IntelliJ or Finder. On a local Mac project, the reader opens the
file directly. A remote server cannot start Mac apps, so the bridge carries the request. It needs a folder that both
sides see: a Lima/virtiofs share, an sshfs mount, or similar. `HOST` is the Mac path and `SERVER` is the same folder
on the server, for example `~/vm-share:/home/me`.

How it works:
1. On the server, the reader writes `SERVER/.claude-chat-bridge/req/<id>.json`:
   `{"id", "path", "line", "app", "root", "ts"}`.
2. launchd starts `~/Library/Application Support/claude-chat/open-bridge.zsh` when that folder changes
   (`WatchPaths`). It also runs every 60 s as a safety net, and it keeps polling for 20 s after the last request.
   With `--bridge-poll` the script runs all the time instead (`KeepAlive`, `--poll 1`) and lists the folder every
   second.
3. The script checks the request and maps the server path to the Mac.
   - It accepts only paths under `SERVER`, with no `.` or `..` segments.
   - The request data goes to commands as arguments, never through a shell string.
4. It opens the file:
   - Zed: `zed path:line`, else `open -a Zed`.
   - IntelliJ: `idea --line N path` (also the Toolbox script), else `open -b com.jetbrains.intellij` or the CE bundle.
   - Finder: reveals the file with AppleScript and brings Finder to the front.
5. It writes `HOST/.claude-chat-bridge/res/<id>.json` (`{"ok":true}` or `{"ok":false,"error":"…"}`) and deletes
   the request. The reader waits up to 5 s for it. Requests older than 60 s are dropped unopened.

Each server gets its own bridge (label and log named after the `--server` value, e.g. `devbox`):
- LaunchAgent: `~/Library/LaunchAgents/dev.claude-chat.open-bridge.devbox.plist`. A single
  `dev.claude-chat.open-bridge.plist` from an older install is replaced on the next install and removed by
  `--uninstall`.
- Script: `~/Library/Application Support/claude-chat/open-bridge.zsh`, a copy of `host/open-bridge.zsh`, shared.
- Log: `~/Library/Logs/claude-chat-open-bridge.devbox.log`.
- On the server: `openBridge: {dir, root}` in `~/.config/claude-chat/config.json`.

Several servers, over sshfs:
```bash
host/install.sh --server devbox --server gpu --bridge-poll \
  --open-bridge devbox=~/mnt/devbox:/home/me --open-bridge gpu=~/mnt/gpu:/srv/work
```
Mount with a short directory cache, e.g. `sshfs devbox:/home/me ~/mnt/devbox -o dir_cache=no` (or
`-o cache_timeout=1`); otherwise the Mac may list the request folder from its cache and see new requests late.
Polling over sshfs is not verified yet; Lima/virtiofs with launchd is the tested setup.

After installing, the installer sends a test request and waits for the answer.

Without a shared folder, use **Copy path** in the chat.

## First use: permission prompts

Muxy asks before an extension does something sensitive. On first use, allow these and choose to remember them:
- running `python3 -c …` on the server, twice: the transcript reader and the agent host CLI;
- opening a terminal tab (the first time a chat continues in a terminal);
- notifications (finished / needs attention) and closing the terminal pane on "Back to chat".

The first Finder reveal through the bridge asks once whether `zsh` may control Finder (System Settings → Privacy &
Security → Automation). macOS may also show a "Background item added" notice for the LaunchAgent.

## Update

```bash
cd ~/src/claude-chat && git pull
```

Then in Muxy: **Settings → Extensions → claude-chat → Reload**. Run `host/install.sh` again with the same flags if
`host/` or `server/` changed; the bridge script and the statusline wrapper are copies.

## Uninstall

Quit Muxy first, then:
```bash
host/install.sh --uninstall --server devbox     # or --local, or no target for the Mac side only
```

This removes the extension registration, the LaunchAgent, its script and the Mac's `.claude-chat-bridge` folder. On
each target, `setup.py --uninstall` restores your previous statusline command and removes the wrapper and the config.
Kept: the checkout, `~/.cache/claude-chat/` on the server, and the extension's storage and permission answers in the
Muxy profile.

## Troubleshooting

- **Diagnostics**: `host/install.sh --check --server <ssh>` (or `--local`). It changes nothing.
- **The extension does not show up or keeps old code**: Settings → Extensions → claude-chat → **Reload**. Sometimes
  it needs a second Reload. Check that the folder in the list is `<checkout>/extension`.
- **"cli start failed" / red boot box**: the agent host is not installed on that server (`--check` →
  `server: installed=false`) or `claude` is not found (`claude: not found`; set `claudeBin` in the config).
  A session's log is `~/.cache/claude-chat/sessions/<sessionId>/daemon.log` on the server; running daemons:
  `echo '{"op":"list"}' | python3 ~/.local/share/claude-chat/claude_chat/cli.py`.
- **Adopting a terminal finds the wrong Claude**: with several Claudes in one directory the newest one wins on a Mac;
  on Linux the `muxy` CLI tells them apart.
- **Open in Zed/IntelliJ/Finder fails**:
  - "bridge not responding": check that the agent is loaded
    (`launchctl print gui/$UID/dev.claude-chat.open-bridge.<server>`), then read
    `~/Library/Logs/claude-chat-open-bridge.<server>.log`.
  - "not found on the Mac": `HOST` and `SERVER` do not point at the same folder.
  - With sshfs, launchd may not notice files that the server writes, and the 60 s safety net is too slow for the
    5 s timeout: install with `--bridge-poll` and mount without a directory cache (see above).
- **Reader errors**: the extension logs them on the server in `~/.cache/claude-chat/errors.log`.
- **Usage strip stays empty**: check `statusline` in `--check`. It should say `state=ours`, and the strip fills after
  Claude's next statusline update.
