// The Sidebar section of the settings view, in place of C4's fallback: the same options on the same key, saying the sidebar's real defaults.
(function () {
  const SORTS = [["manual", "Manual (drag)"], ["name", "Name"], ["activity", "Last activity"], ["status", "Status"]];

  function get() {
    return CC.SidebarModel.normalizeView(CC.settings.get("sidebar"));
  }

  function save(patch) {
    CC.settings.set("sidebar", Object.assign(get(), patch));
  }

  function render(body, ui) {
    const s = get();
    const rows = ui.group(body, "Chat rows");
    ui.row(rows, {
      title: "Text lines",
      text: "Lines under a title at rest, for the open and unread chats. The others get one.",
      control: ui.select([["0", "None"], ["1", "1"], ["2", "2"], ["3", "3"]], String(s.lines), function (v) {
        save({ lines: Number(v) });
      }),
    });
    ui.row(rows, {
      title: "Text",
      text: "What those lines show.",
      control: ui.select([["reply", "Last reply"], ["prompt", "Last prompt"], ["both", "Prompt and reply"]], s.text, function (v) {
        save({ text: v });
      }),
    });
    [["model", "Show the model", "Which model the chat runs on."], ["time", "Show the last activity", "How long ago the chat last moved."], ["cost", "Show the cost", "What the chat has cost so far."]].forEach(function (m) {
      ui.row(rows, {
        title: m[1],
        text: m[2],
        control: ui.toggle(s.meta.indexOf(m[0]) >= 0, function (on) {
          const rest = get().meta.filter(function (x) {
            return x !== m[0];
          });
          save({ meta: on ? rest.concat([m[0]]) : rest });
        }),
      });
    });
    const list = ui.group(body, "The list");
    ui.row(list, {
      title: "Group by",
      text: "State puts what needs you first.",
      control: ui.select([["state", "State"], ["project", "Project"]], s.groupBy, function (v) {
        save({ groupBy: v });
      }),
    });
    ui.row(list, {
      title: "Hide stopped chats idle for",
      text: "A chat that needs you stays, however old.",
      control: ui.select([["0", "Never"], ["1", "1 day"], ["3", "3 days"], ["7", "7 days"], ["30", "30 days"]], String(s.maxAgeDays), function (v) {
        save({ maxAgeDays: Number(v) });
      }),
    });
    ui.row(list, {
      title: "Hide inactive chats",
      text: "Chats without a running session. One that's open in a pane or needs you stays.",
      control: ui.toggle(s.hideInactive, function (v) {
        save({ hideInactive: v });
      }),
    });
    ui.row(list, {
      title: "Show terminals",
      text: "Terminal tabs as rows.",
      control: ui.toggle(s.showTerminals, function (v) {
        save({ showTerminals: v });
      }),
    });
    ui.row(list, {
      title: "Sort projects by",
      text: "Manual keeps the order you dragged them into.",
      control: ui.select(SORTS, s.sortProjects, function (v) {
        save({ sortProjects: v });
      }),
    });
    ui.row(list, {
      title: "Sort chats by",
      text: "Inside each group.",
      control: ui.select(SORTS, s.sortChats, function (v) {
        save({ sortChats: v });
      }),
    });
  }

  CC.SettingsView.section("sidebar", { label: "Sidebar", order: 50, render: render });
})();
