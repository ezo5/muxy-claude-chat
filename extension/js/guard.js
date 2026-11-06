// Loaded first and on its own: Muxy webviews have no devtools, so a failure before the app is up must say so on the page.
window.CC = window.CC || {};

CC.fatal = function (text) {
  const app = document.getElementById("app");
  if (app == null) {
    return;
  }
  const box = document.createElement("div");
  box.className = "cc-fatal";
  box.textContent = text;
  app.replaceChildren(box);
};

(function () {
  function report(detail) {
    if (CC.started !== true) {
      CC.fatal("Claude Chat couldn't start: " + detail);
    }
  }
  window.addEventListener("error", function (e) {
    const target = e.target;
    if (target != null && target !== window && (target.src || target.href)) {
      report("couldn't load " + (target.src || target.href));
      return;
    }
    report(e.message || "unknown error");
  }, true);
  window.addEventListener("unhandledrejection", function (e) {
    report(e.reason != null && e.reason.message ? e.reason.message : String(e.reason));
  });
})();
