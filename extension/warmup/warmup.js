// TEMPORARY (see background.src.js): opens every not yet loaded chat tab of the current project once, so its page
// runs and sets the tab title, then returns to the tab that was active.
(function () {
  const DEFAULT_TITLE = "Claude Chat";

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  async function settle(id) {
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      const tab = (await muxy.tabs.list()).find(function (t) {
        return t.id === id;
      });
      if (tab == null || tab.title !== DEFAULT_TITLE) {
        return;
      }
    }
  }

  async function run() {
    const tabs = await muxy.tabs.list();
    const active = tabs.find(function (t) {
      return t.isActive;
    });
    const cold = tabs.filter(function (t) {
      return t.kind === "extensionWebView" && t.title === DEFAULT_TITLE && !t.isActive;
    });
    for (let i = 0; i < cold.length; i++) {
      await muxy.tabs.switchTo(cold[i].id);
      await settle(cold[i].id);
    }
    if (cold.length > 0 && active != null) {
      await muxy.tabs.switchTo(active.id);
    }
  }

  async function project() {
    try {
      const p = (await muxy.projects.list()).find(function (x) {
        return x.isActive;
      });
      return p != null ? p.id : null;
    } catch (e) {
      return null;
    }
  }

  (async function () {
    const id = await project();
    try {
      await run();
    } catch (e) {
      console.warn("warmup failed", e && e.message);
    }
    muxy.events.emit("extension.warmup", { project: id }).catch(function () {});
    muxy.modal.closeWebview();
  })();
})();
