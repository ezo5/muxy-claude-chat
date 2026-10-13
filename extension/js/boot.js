// Shows startup errors in the page; muxy webviews have no devtools.
(function () {
  function show(msg) {
    let host = document.getElementById("boot-errors");
    if (host == null) {
      host = document.createElement("div");
      host.id = "boot-errors";
      host.className = "boot-errors";
      (document.body || document.documentElement).appendChild(host);
    }
    const box = document.createElement("pre");
    box.className = "boot-error";
    box.textContent = msg;
    if (window.CC != null && CC.util != null) {
      box.appendChild(CC.util.copyButton(function () {
        return msg;
      }));
    }
    host.appendChild(box);
  }
  // Capture phase: failed <script>/<link> loads don't bubble and never reach a plain error listener.
  window.addEventListener("error", function (e) {
    const t = e.target;
    if (t != null && t !== window && (t.src || t.href)) {
      show("Failed to load " + (t.src || t.href).split("/").pop() + "\nReload the extension (Settings → Extensions → Reload).");
      return;
    }
    // Benign: an observer callback changed layout and the rest is delivered next frame.
    if (/^ResizeObserver loop/.test(e.message || "")) {
      return;
    }
    show("Something went wrong\n" + e.message + (e.filename ? "\n" + e.filename.split("/").pop() + ":" + e.lineno : ""));
  }, true);
  if (typeof window.muxy === "undefined") {
    window.addEventListener("DOMContentLoaded", function () {
      show("Muxy is not connected\nThe muxy API is missing in this page (bridge not injected).");
    });
  }
})();
