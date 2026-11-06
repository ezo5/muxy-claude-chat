// Everything here runs from the app's start, also in a tab nobody is looking at. The sample has no server, so no exec and no prompt for it.
CC.bus.on("app:ready", function () {
  if (CC.devSample == null) {
    CC.Chatless.start();
    CC.Notices.checkServer();
    CC.Notices.tip();
    CC.ChatRequests.start();
  }
  [CC.Alerts.start, CC.Navigate.start].forEach(function (start) {
    try {
      start();
    } catch (e) {
      console.error("Claude Chat: part of the app didn't start", e);
      CC.ui.toast("Part of Claude Chat didn't start: " + (e && e.message ? e.message : e), { level: "error" });
    }
  });
});
