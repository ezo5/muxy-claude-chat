#!/usr/bin/env python3
"""Makes Muxy only the window that shows the claude-chat page: none of its shortcuts or chrome in the way.

Muxy keeps every bound shortcut from a page, and a built-in one can't be unbound, only moved. So each goes to a chord
nobody presses; it stays in Muxy's menus. Only what any Mac app has stays on its keys: quit, hide, minimize, full screen.
[appearance] takes away the tab strip, the sidebar, the bars and the pane headers. Edits settings.toml, which Muxy reads at
start and on `muxy config reload` (2.4): install.sh runs that when Muxy is running, as it would otherwise write its own copy back.

  keymap.py apply|remove|check <settings.toml>
"""
import re
import string
import sys

PARKED = [
    "new_tab", "new_home_tab", "new_tab_in_project", "new_browser_tab", "new_worktree", "switch_worktree",
    "existing_terminals", "add_project",
    "close_tab", "close_pane",
    "next_tab", "previous_tab", "next_project", "previous_project", "navigate_back", "navigate_forward",
    "split_right", "split_down", "focus_pane_left", "focus_pane_right", "focus_pane_up", "focus_pane_down",
    "toggle_zoom_pane", "equalize_splits",
    "toggle_sidebar", "toggle_agents_panel", "toggle_composer",
    "toggle_theme_picker", "toggle_command_palette", "open_settings",
    "scroll_to_bottom", "increase_font_size", "decrease_font_size",
] + ["select_tab%d" % n for n in range(1, 10)] + ["select_project%d" % n for n in range(1, 10)]

# Parked before Muxy dropped them (voice input, 2.4): apply and remove take their lines away.
RETIRED = ["toggle_voice_recording"]

# Muxy's own extensions, whose panels open on these keys. An extension's shortcut can be taken away; an empty value does it.
UNASSIGNED = [
    "extension.files.toggle-files", "extension.files.files-quick-open", "extension.files.files-find-in-files",
    "extension.git.toggle-scm", "extension.git.checkout-pr",
]

# As TOML values. `remove` drops those still at these values, which brings back Muxy's defaults.
APPEARANCE = {
    "layout": '"tab_focused"',
    "sidebar_expanded": "false",
    "sidebar_collapsed_style": '"hidden"',
    "status_bar_visible": "false",
    "pane_headers": "false",
    "tips_visible": "false",
    "agents_panel_visible": "false",
}

PREFIX = "cmd-ctrl-alt-shift-"
KEYS = list(string.ascii_lowercase) + list(string.digits) + ["f%d" % n for n in range(1, 25)]
SECTION = re.compile(r"^\s*\[")
ENTRY = re.compile(r'^\s*"?([^"=\s]+)"?\s*=\s*"([^"]*)"')
SETTING = re.compile(r"^\s*(\w+)\s*=\s*(.+?)\s*$")


def section_range(lines, name):
    """The lines of [name] as (first, end), or None."""
    for i, line in enumerate(lines):
        if line.strip() == "[%s]" % name:
            end = i + 1
            while end < len(lines) and not SECTION.match(lines[end]):
                end += 1
            return i + 1, end
    return None


def entries(lines):
    found = section_range(lines, "keymap")
    if found is None:
        return {}
    matches = (ENTRY.match(line) for line in lines[found[0]:found[1]])
    return {m.group(1): m.group(2) for m in matches if m is not None}


def is_ours(action, chord):
    return (action in PARKED and chord.startswith(PREFIX)) or (action in UNASSIGNED and chord == "")


def retired(line):
    m = ENTRY.match(line)
    return m is not None and m.group(1) in RETIRED and m.group(2).startswith(PREFIX)


def add_to_section(text, name, added):
    if not added:
        return text
    lines = text.split("\n")
    found = section_range(lines, name)
    if found is None:
        return text.rstrip("\n") + "\n\n[%s]\n" % name + "\n".join(added) + "\n"
    return "\n".join(lines[:found[0]] + added + lines[found[0]:])


def apply_appearance(text):
    lines = text.split("\n")
    found = section_range(lines, "appearance")
    seen = set()
    if found is not None:
        for i in range(found[0], found[1]):
            m = SETTING.match(lines[i])
            if m is not None and m.group(1) in APPEARANCE:
                seen.add(m.group(1))
                lines[i] = "%s = %s" % (m.group(1), APPEARANCE[m.group(1)])
    added = ["%s = %s" % (k, v) for k, v in APPEARANCE.items() if k not in seen]
    return add_to_section("\n".join(lines), "appearance", added)


def apply(text):
    text = without(text, "keymap", retired)
    current = entries(text.split("\n"))
    taken = set(current.values())
    free = [PREFIX + key for key in KEYS if PREFIX + key not in taken]
    # What's in the file already is the user's choice.
    added = ['%s = "%s"' % (action, free.pop(0)) for action in PARKED if action not in current]
    added += ['"%s" = ""' % action for action in UNASSIGNED if action not in current]
    return apply_appearance(add_to_section(text, "keymap", added))


def without(text, name, drop):
    """Drops the section's lines drop(line) says, and the section's header when nothing is left of it."""
    lines = text.split("\n")
    found = section_range(lines, name)
    if found is None:
        return text
    kept = [line for line in lines[found[0]:found[1]] if not drop(line)]
    if name == "appearance" and not any(line.strip() for line in kept):
        head = lines[:found[0] - 1]
        if head and head[-1] == "":
            head = head[:-1]
        return "\n".join(head + kept + lines[found[1]:])
    return "\n".join(lines[:found[0]] + kept + lines[found[1]:])


def remove(text):
    def ours_key(line):
        m = ENTRY.match(line)
        return (m is not None and is_ours(m.group(1), m.group(2))) or retired(line)

    def ours_look(line):
        m = SETTING.match(line)
        return m is not None and APPEARANCE.get(m.group(1)) == m.group(2)

    return without(without(text, "keymap", ours_key), "appearance", ours_look)


def main(argv):
    if len(argv) != 3 or argv[1] not in ("apply", "remove", "check"):
        print(__doc__.strip(), file=sys.stderr)
        return 2
    mode, path = argv[1], argv[2]
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except FileNotFoundError:
        text = ""
    if mode == "check":
        current = entries(text.split("\n"))
        print("%d of %d shortcuts moved" % (sum(1 for a, c in current.items() if is_ours(a, c)), len(PARKED) + len(UNASSIGNED)))
        return 0
    changed = apply(text) if mode == "apply" else remove(text)
    if changed != text:
        with open(path, "w", encoding="utf-8") as f:
            f.write(changed)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
