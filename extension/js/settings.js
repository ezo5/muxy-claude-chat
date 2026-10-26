window.CC = window.CC || {};

// Settings dialog: sections listed on the left, one pane on the right. Add a section to `sections` to extend it.
CC.Settings = (function () {
  const util = CC.util;
  const el = util.el;

  function Settings(btn, modes, actions) {
    this.btn = btn;
    this.modes = modes;
    this.actions = actions || [];
    this.active = "general";
    this.sections = [
      { id: "general", label: "General", render: this.renderGeneral },
      { id: "typography", label: "Typography", render: this.renderTypography },
      { id: "layout", label: "Layout", render: this.renderLayout },
    ];
    this.overlay = el("div", "settings-overlay hidden");
    this.box = el("div", "settings-dialog");
    this.box.setAttribute("role", "dialog");
    this.box.setAttribute("aria-label", "Settings");
    this.overlay.appendChild(this.box);
    document.body.appendChild(this.overlay);
    const self = this;
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      self.toggle();
    });
    this.overlay.addEventListener("mousedown", function (e) {
      if (e.target === self.overlay) {
        self.close();
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !self.overlay.classList.contains("hidden")) {
        e.preventDefault();
        self.close();
      }
    });
  }

  Settings.prototype.render = function () {
    const self = this;
    this.box.textContent = "";
    const nav = el("nav", "settings-nav");
    nav.appendChild(el("div", "settings-heading", "Settings"));
    const pane = el("div", "settings-pane");
    this.sections.forEach(function (s) {
      const b = el("button", "settings-tab" + (s.id === self.active ? " active" : ""), s.label);
      b.type = "button";
      b.addEventListener("click", function () {
        self.active = s.id;
        self.render();
      });
      nav.appendChild(b);
    });
    const section = this.sections.find(function (s) {
      return s.id === self.active;
    });
    const head = el("div", "settings-pane-head");
    head.appendChild(el("div", "settings-pane-title", section.label));
    const close = el("button", "hdr-btn settings-close");
    close.type = "button";
    close.title = "Close";
    close.innerHTML = CC.icons.x;
    close.addEventListener("click", function () {
      self.close();
    });
    head.appendChild(close);
    const body = el("div", "settings-body");
    section.render.call(this, body);
    pane.append(head, body);
    this.box.append(nav, pane);
  };

  Settings.prototype.group = function (parent, title) {
    const g = el("div", "settings-group");
    if (title != null) {
      g.appendChild(el("div", "settings-title", title));
    }
    parent.appendChild(g);
    return g;
  };

  Settings.prototype.radio = function (name, value, label, checked) {
    const row = el("label", "settings-row");
    const input = el("input");
    input.type = "radio";
    input.name = name;
    input.value = value;
    input.checked = checked;
    row.append(input, el("span", "", label));
    return row;
  };

  Settings.prototype.renderGeneral = function (body) {
    const self = this;
    const s = this.modes.settings;
    const modeGroup = this.group(body, "New chats open in");
    ["chat", "terminal"].forEach(function (mode) {
      const row = self.radio("default-mode", mode, mode === "chat" ? "Chat" : "Terminal", s.defaultMode === mode);
      row.firstChild.addEventListener("change", function () {
        self.modes.saveSettings({ defaultMode: mode });
      });
      modeGroup.appendChild(row);
    });
    const termGroup = this.group(body, "Terminal mode");
    const auto = el("label", "settings-row");
    const check = el("input");
    check.type = "checkbox";
    check.checked = s.autoReturn;
    check.addEventListener("change", function () {
      self.modes.saveSettings({ autoReturn: check.checked });
    });
    auto.append(check, el("span", "", "Back to chat when the terminal Claude exits"));
    termGroup.appendChild(auto);
    const mdGroup = this.group(body, "Markdown files");
    const mdRow = el("label", "settings-row");
    const mdCheck = el("input");
    mdCheck.type = "checkbox";
    mdCheck.checked = CC.typography.get().renderMarkdown;
    mdCheck.addEventListener("change", function () {
      CC.typography.save({ renderMarkdown: mdCheck.checked });
    });
    mdRow.append(mdCheck, el("span", "", "Show read and written .md files rendered (toggle per file in its header)"));
    mdGroup.appendChild(mdRow);
    if (this.actions.length > 0) {
      const actGroup = this.group(body, "This chat");
      this.actions.forEach(function (a) {
        const b = el("button", "settings-action", a.label);
        b.type = "button";
        b.addEventListener("click", function () {
          self.close();
          a.run();
        });
        actGroup.appendChild(b);
      });
    }
  };

  // Presets, the fonts installed on the Mac ("font:<family>", saved as custom) and a text field for "custom".
  Settings.prototype.fontField = function (parent, label, options, value, custom, onChange) {
    const row = el("div", "settings-field");
    row.appendChild(el("label", "settings-label", label));
    const ctl = el("div", "settings-ctl");
    const select = el("select", "settings-select");
    options.forEach(function (o) {
      const opt = el("option", "", o[1]);
      opt.value = o[0];
      opt.selected = o[0] === value;
      select.appendChild(opt);
    });
    const input = el("input", "settings-input");
    input.type = "text";
    input.placeholder = "Font family, e.g. JetBrains Mono";
    input.spellcheck = false;
    input.value = custom;
    input.classList.toggle("hidden", value !== "custom");
    CC.typography.fonts().then(function (names) {
      if (names.length === 0) {
        return;
      }
      const group = el("optgroup");
      group.label = "Installed fonts";
      names.forEach(function (name) {
        const opt = el("option", "", name);
        opt.value = "font:" + name;
        group.appendChild(opt);
      });
      select.appendChild(group);
      if (value === "custom" && names.indexOf(custom) !== -1 && select.value === "custom") {
        select.value = "font:" + custom;
        input.classList.add("hidden");
      }
    });
    select.addEventListener("change", function () {
      if (select.value.indexOf("font:") === 0) {
        input.value = select.value.slice(5);
        input.classList.add("hidden");
        onChange("custom", input.value);
        return;
      }
      input.classList.toggle("hidden", select.value !== "custom");
      onChange(select.value, input.value);
      if (select.value === "custom") {
        input.focus();
      }
    });
    input.addEventListener("input", function () {
      onChange(select.value, input.value);
    });
    ctl.append(select, input);
    row.appendChild(ctl);
    parent.appendChild(row);
  };

  Settings.prototype.slider = function (parent, label, min, max, step, value, fmt, onChange) {
    const row = el("div", "settings-field");
    row.appendChild(el("label", "settings-label", label));
    const ctl = el("div", "settings-ctl settings-range");
    const input = el("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    const out = el("span", "settings-value", fmt(value));
    input.addEventListener("input", function () {
      const v = Number(input.value);
      out.textContent = fmt(v);
      onChange(v);
    });
    ctl.append(input, out);
    row.appendChild(ctl);
    parent.appendChild(row);
  };

  Settings.prototype.renderTypography = function (body) {
    const self = this;
    const t = CC.typography;
    const s = t.get();
    const px = function (v) {
      return v + " px";
    };
    const text = this.group(body, "Chat text");
    this.fontField(text, "Font", t.FONTS, s.font, s.customFont, function (font, customFont) {
      t.save({ font: font, customFont: customFont });
    });
    this.slider(text, "Size", 12, 20, 0.5, s.size, px, function (v) {
      t.save({ size: v });
    });
    this.slider(text, "Line height", 1.2, 2.2, 0.05, s.lineHeight, function (v) {
      return v.toFixed(2);
    }, function (v) {
      t.save({ lineHeight: v });
    });
    const code = this.group(body, "Code");
    this.fontField(code, "Font", t.CODE_FONTS, s.codeFont, s.customCodeFont, function (font, customFont) {
      t.save({ codeFont: font, customCodeFont: customFont });
    });
    this.slider(code, "Size", 10, 18, 0.5, s.codeSize, px, function (v) {
      t.save({ codeSize: v });
    });
    const schemeRow = el("div", "settings-field");
    schemeRow.appendChild(el("label", "settings-label", "Color scheme"));
    const schemeCtl = el("div", "settings-ctl");
    const scheme = el("select", "settings-select");
    t.CODE_SCHEMES.forEach(function (o) {
      const opt = el("option", "", o[1]);
      opt.value = o[0];
      opt.selected = o[0] === s.codeScheme;
      scheme.appendChild(opt);
    });
    scheme.addEventListener("change", function () {
      t.save({ codeScheme: scheme.value });
    });
    schemeCtl.appendChild(scheme);
    schemeRow.appendChild(schemeCtl);
    code.appendChild(schemeRow);
    const preview = this.group(body, "Preview");
    const sample = el("div", "settings-preview");
    sample.appendChild(CC.markdown.render("The quick brown fox jumps over the lazy dog. Příliš žluťoučký kůň úpěl ďábelské ódy — run `npm test` before you push.\n\n```js\n// the answer\nfunction answer(name) {\n  return { name: \"deep thought\", value: 42 };\n}\n```"));
    preview.appendChild(sample);
    const reset = el("button", "settings-action", "Reset to defaults");
    reset.type = "button";
    reset.addEventListener("click", function () {
      t.reset().then(function () {
        self.render();
      });
    });
    body.appendChild(reset);
  };

  Settings.prototype.renderLayout = function (body) {
    const self = this;
    const t = CC.typography;
    const s = t.get();
    const group = this.group(body, "Chat width");
    t.WIDTHS.forEach(function (w) {
      const row = self.radio("chat-width", w[0], w[1] + " · " + w[2], s.width === w[0]);
      row.firstChild.addEventListener("change", function () {
        t.save({ width: w[0] });
      });
      group.appendChild(row);
    });
  };

  Settings.prototype.toggle = function () {
    if (this.overlay.classList.contains("hidden")) {
      this.open();
    } else {
      this.close();
    }
  };

  Settings.prototype.open = function () {
    this.render();
    this.overlay.classList.remove("hidden");
    this.btn.classList.add("active");
  };

  Settings.prototype.close = function () {
    this.overlay.classList.add("hidden");
    this.btn.classList.remove("active");
  };

  return Settings;
})();
