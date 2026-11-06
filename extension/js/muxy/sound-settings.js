// Settings, Notifications. Where system sounds exist each alert picks one; elsewhere it's on or off, as the tone is all there is.
CC.SettingsView.section("notifications", {
  label: "Notifications",
  order: 40,
  render: function (body, ui) {
    const s = CC.Sounds.settings();
    const names = CC.Sounds.names();
    const ALERTS = [
      ["attention", "Needs your attention", "When a chat is waiting for an answer or a permission."],
      ["finished", "Finished working", "When a chat comes to the end of its turn."],
    ];

    function preview(kind) {
      CC.Sounds.preview(kind).catch(function (e) {
        CC.ui.toast("Sound failed: " + (e && e.message ? e.message : e), { level: "error" });
      });
    }

    function soundControl(kind) {
      const box = CC.util.el("div", "cc-set-sound");
      const on = CC.Sounds.DEFAULTS[kind];
      const options = names.length > 0 ? names.map(function (n) {
        return [n, n];
      }) : [[on, "On"]];
      const current = !s[kind] ? "" : names.length > 0 ? s[kind] : on;
      const button = CC.ui.iconButton({ icon: "play", label: "Play", size: 14, onClick: function () {
        preview(kind);
      } });
      button.disabled = current === "";
      box.appendChild(ui.select([["", "Off"]].concat(options), current, function (v) {
        const patch = {};
        patch[kind] = v || null;
        CC.Sounds.save(patch);
        button.disabled = !v;
        if (v) {
          preview(kind);
        }
      }));
      box.appendChild(button);
      return box;
    }

    const sounds = ui.group(body, "Sound");
    ALERTS.forEach(function (a) {
      ui.row(sounds, { title: a[1], text: a[2], control: soundControl(a[0]) });
    });
    ui.row(sounds, {
      title: "Volume",
      text: "For both sounds.",
      control: ui.slider({ min: 0.05, max: 1, step: 0.05, value: s.volume, format: function (v) {
        return Math.round(v * 100) + " %";
      }, onChange: function (v) {
        CC.Sounds.save({ volume: v });
      } }),
    });

    const when = ui.group(body, "When");
    [
      ["focused", "Also when the chat is focused", "By default a chat you're looking at stays quiet."],
      ["banner", "Show a banner too", "A system notification along with the sound."],
    ].forEach(function (k) {
      ui.row(when, { title: k[1], text: k[2], control: ui.toggle(s[k[0]] === true, function (v) {
        const patch = {};
        patch[k[0]] = v;
        CC.Sounds.save(patch);
      }) });
    });
    body.appendChild(CC.util.el("p", "cc-set-note", "These sounds cover terminal sessions too, so turn Muxy's own notifications off in the system settings to avoid hearing two."));
  },
});
