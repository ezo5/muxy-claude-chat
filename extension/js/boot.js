// Last in the bundle, so every area has registered itself by the time it runs.
(function () {
  function query(name) {
    return new URLSearchParams(location.search).get(name);
  }

  // The sample chats, for the dev harness only. A Muxy tab has no query, and a build with --no-sample doesn't have them.
  function sampleWanted() {
    return query("sample") === "1";
  }

  function loadTag(tag, attrs) {
    return new Promise(function (resolve, reject) {
      const node = document.createElement(tag);
      Object.keys(attrs).forEach(function (k) {
        node[k] = attrs[k];
      });
      node.onload = resolve;
      node.onerror = function () {
        reject(new Error("couldn't load " + (attrs.src || attrs.href)));
      };
      document.head.appendChild(node);
    });
  }

  // A tab of when each server had its own: its data names the project it was opened in. Only the one in this computer's Home runs, and a page can't close its own tab.
  async function oldTab() {
    const data = CC.host.app.data();
    if (data == null || data.projectId == null) {
      return false;
    }
    const home = (await CC.host.projects.list())[0];
    if (home == null || String(home.id) === String(data.projectId)) {
      return false;
    }
    const app = document.getElementById("app");
    const box = CC.util.el("div", "cc-moved");
    box.appendChild(CC.util.el("div", null, "Claude Chat is one tab now, with every server in it. You can close this one."));
    box.appendChild(CC.ui.button({
      label: "Open Claude Chat",
      onClick: function () {
        Promise.resolve(CC.host.app.openHere()).catch(function (e) {
          CC.ui.toast("Couldn't open it: " + (e && e.message ? e.message : e), { level: "error" });
        });
      },
    }));
    app.replaceChildren(box);
    return true;
  }

  function applyScheme() {
    document.documentElement.dataset.scheme = CC.host.theme.scheme();
  }

  async function start() {
    if (CC.host == null) {
      CC.fatal("Claude Chat runs inside Muxy. Open it from Muxy's top bar.");
      return;
    }
    applyScheme();
    CC.host.theme.onChange(applyScheme);
    if (sampleWanted()) {
      await loadTag("link", { rel: "stylesheet", href: "css/dev-sample.css" });
      await loadTag("script", { src: "js/dev-sample.js" });
      await CC.devSample.install();
    }
    if (CC.devSample == null) {
      if (CC.host.tabOnly !== true) {
        if (await oldTab()) {
          return;
        }
        if (!(await CC.Servers.start())) {
          return;
        }
        await CC.MoveState.run();
      }
      await CC.ImportV2.run();
    }
    await CC.settings.load();
    await CC.Shell.start(document.getElementById("app"));
    CC.started = true;
    CC.bus.emit("app:ready");
  }

  start().catch(function (e) {
    console.error("boot failed", e);
    CC.fatal("Claude Chat couldn't start: " + (e && e.message ? e.message : e));
  });
})();
