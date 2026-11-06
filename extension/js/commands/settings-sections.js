// The sections of §11. Notifications is the Muxy side package's. Sidebar is marked fallback: its owner may register a section with the same id, which replaces them.
(function () {
  const el = CC.util.el;
  const section = CC.SettingsView.section;

  function general(body, ui) {
    const t = CC.typography;
    const modes = ui.group(body, "New chats");
    ui.row(modes, {
      title: "Open new chats in",
      text: "Chat is the full view here, terminal is the native Claude Code.",
      control: ui.select([["chat", "Chat"], ["terminal", "Terminal"]], CC.settings.get("defaultMode") || "chat", function (v) {
        CC.settings.set("defaultMode", v);
      }),
    });
    ui.row(modes, {
      title: "Back to chat when the terminal exits",
      text: "When Claude Code quits in a chat's terminal, the chat picks up where it ended.",
      control: ui.toggle(CC.settings.get("autoReturn") !== false, function (v) {
        CC.settings.set("autoReturn", v);
      }),
    });
    const files = ui.group(body, "Markdown files");
    ui.row(files, {
      title: "Show .md files rendered",
      text: "For files Claude read or wrote. Each file's header can still switch it.",
      control: ui.toggle(t.get().renderMarkdown, function (v) {
        t.save({ renderMarkdown: v });
      }),
    });
    const chat = ui.group(body, "This chat");
    const runtime = ui.view.chatRuntime();
    const button = CC.ui.button({ label: "Export", onClick: function () {
      const now = ui.view.chatRuntime();
      if (now != null) {
        CC.Export.run(now);
      }
    } });
    button.disabled = runtime == null;
    ui.row(chat, {
      title: "Export as Markdown",
      text: runtime != null ? "Writes the chat on screen to a file next to its project." : "Open a chat beside this view to export it.",
      control: button,
    });
  }

  // Presets, the installed fonts ("font:<family>", saved as custom) and a text field for "custom".
  function fontRow(parent, ui, o) {
    const select = ui.select(o.options, o.value, change);
    const input = ui.text(o.custom, "Font family", function () {
      o.onChange(select.value.indexOf("font:") === 0 ? "custom" : select.value, input.value);
    });
    input.setAttribute("aria-label", o.title + ", custom family");
    input.hidden = o.value !== "custom";
    const box = el("div", "cc-set-font");
    box.append(select, input);
    function change() {
      if (select.value.indexOf("font:") === 0) {
        input.value = select.value.slice(5);
        input.hidden = true;
        o.onChange("custom", input.value);
        return;
      }
      input.hidden = select.value !== "custom";
      o.onChange(select.value, input.value);
      if (!input.hidden) {
        input.focus();
      }
    }
    CC.typography.fonts().then(function (names) {
      if (names.length === 0 || !select.isConnected) {
        return;
      }
      const list = el("optgroup");
      list.label = "Installed fonts";
      names.forEach(function (name) {
        const opt = el("option", null, name);
        opt.value = "font:" + name;
        list.appendChild(opt);
      });
      select.appendChild(list);
      if (o.value === "custom" && names.indexOf(o.custom) !== -1 && select.value === "custom") {
        select.value = "font:" + o.custom;
        input.hidden = true;
      }
    });
    ui.row(parent, { title: o.title, text: o.text, control: box });
  }

  const PREVIEW = "The quick brown fox jumps over the lazy dog. Run `npm test` before you push.\n\n```js\n// the answer\nfunction answer(name) {\n  return { name: \"deep thought\", value: 42 };\n}\n```";

  function typography(body, ui) {
    const t = CC.typography;
    const s = t.get();
    function px(v) {
      return v + " px";
    }
    const chat = ui.group(body, "Chat text");
    fontRow(chat, ui, {
      title: "Font",
      text: "For prompts and answers.",
      options: t.FONTS.map(function (f) {
        return [f[0], f[1]];
      }),
      value: s.font,
      custom: s.customFont,
      onChange: function (font, custom) {
        t.save({ font: font, customFont: custom });
      },
    });
    ui.row(chat, {
      title: "Size",
      text: "Applies to every pane at once.",
      control: ui.slider({ min: 12, max: 20, step: 0.5, value: s.size, format: px, onChange: function (v) {
        t.save({ size: v });
      } }),
    });
    ui.row(chat, {
      title: "Line height",
      text: "Space between lines of a paragraph.",
      control: ui.slider({ min: 1.2, max: 2.2, step: 0.05, value: s.lineHeight, format: function (v) {
        return v.toFixed(2);
      }, onChange: function (v) {
        t.save({ lineHeight: v });
      } }),
    });
    ui.row(chat, {
      title: "Single newline is a line break",
      text: "For new messages; older ones keep how they were rendered.",
      control: ui.toggle(s.breaks, function (v) {
        t.save({ breaks: v });
      }),
    });
    const code = ui.group(body, "Code");
    fontRow(code, ui, {
      title: "Font",
      text: "For code blocks and the review.",
      options: t.CODE_FONTS.map(function (f) {
        return [f[0], f[1]];
      }),
      value: s.codeFont,
      custom: s.customCodeFont,
      onChange: function (font, custom) {
        t.save({ codeFont: font, customCodeFont: custom });
      },
    });
    ui.row(code, {
      title: "Size",
      text: "For code blocks and the review.",
      control: ui.slider({ min: 10, max: 18, step: 0.5, value: s.codeSize, format: px, onChange: function (v) {
        t.save({ codeSize: v });
      } }),
    });
    ui.row(code, {
      title: "Color scheme",
      text: "Muxy theme follows light and dark by itself.",
      control: ui.select(t.CODE_SCHEMES, s.codeScheme, function (v) {
        t.save({ codeScheme: v });
      }),
    });
    const preview = ui.group(body, "Preview");
    const sample = el("div", "cc-set-preview");
    sample.appendChild(CC.Commands.markdown(PREVIEW));
    preview.appendChild(sample);
    const foot = el("div", "cc-cmd-actions");
    foot.appendChild(CC.ui.button({ label: "Reset to defaults", onClick: function () {
      t.reset();
      ui.view.paint();
    } }));
    body.appendChild(foot);
  }

  function layout(body, ui) {
    const t = CC.typography;
    const group = ui.group(body, "Content");
    ui.row(group, {
      title: "Chat width",
      text: "How wide the conversation gets; a narrower pane always wins.",
      control: ui.select(t.WIDTHS.map(function (w) {
        return [w[0], w[1] + " (" + w[3] + ")"];
      }), t.get().width, function (v) {
        t.save({ width: v });
      }),
    });
  }

  // Kept as one object, the shape 2.x stores, so the import has nothing to translate.
  const SIDEBAR_DEFAULTS = { lines: 2, text: "reply", meta: ["time"], maxAgeDays: 0, showTerminals: true, sortProjects: "manual", sortChats: "manual" };

  function sidebar(body, ui) {
    function get() {
      return Object.assign({}, SIDEBAR_DEFAULTS, CC.settings.get("sidebar") || {});
    }
    function save(patch) {
      CC.settings.set("sidebar", Object.assign(get(), patch));
    }
    const s = get();
    const rows = ui.group(body, "Chat rows");
    ui.row(rows, {
      title: "Text lines",
      text: "Lines under a title, for the open and unread chats.",
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
      title: "Hide stopped chats idle for",
      text: "A chat that needs you stays, however old.",
      control: ui.select([["0", "Never"], ["1", "1 day"], ["3", "3 days"], ["7", "7 days"], ["30", "30 days"]], String(s.maxAgeDays), function (v) {
        save({ maxAgeDays: Number(v) });
      }),
    });
    ui.row(list, {
      title: "Show terminals",
      text: "Terminal tabs under their project.",
      control: ui.toggle(s.showTerminals, function (v) {
        save({ showTerminals: v });
      }),
    });
    const sorts = [["manual", "Manual (drag)"], ["name", "Name"], ["activity", "Last activity"], ["status", "Status"]];
    ui.row(list, {
      title: "Sort projects by",
      text: "Manual keeps the order you dragged them into.",
      control: ui.select(sorts, s.sortProjects, function (v) {
        save({ sortProjects: v });
      }),
    });
    ui.row(list, {
      title: "Sort chats by",
      text: "Inside each project.",
      control: ui.select(sorts, s.sortChats, function (v) {
        save({ sortChats: v });
      }),
    });
  }

  function server(body, ui) {
    const group = ui.group(body, "This server");
    ui.row(group, {
      title: "Server config",
      text: "~/.config/claude-chat/config.json holds claudeBin, idleStopMs, extraArgs and usageDir. Most setups don't need it.",
      control: CC.ui.button({ label: "Open", onClick: function () {
        CC.Commands.open(ui.view.chatRuntime(), "~/.config/claude-chat/config.json");
      } }),
    });
  }

  section("general", { label: "General", order: 10, render: general });
  section("typography", { label: "Typography", order: 20, render: typography });
  section("layout", { label: "Layout", order: 30, render: layout });
  section("sidebar", { label: "Sidebar", order: 50, fallback: true, render: sidebar });
  section("server", { label: "Server", order: 60, render: server });
})();
