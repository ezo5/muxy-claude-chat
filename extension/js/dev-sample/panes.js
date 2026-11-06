// Sample Review pane, to see panes beside a chat before the real one exists.
CC.devSample.registerPanes = function () {
  const el = CC.util.el;

  function fileEl(ctx, f) {
    const viewed = ctx.runtime.ui.viewed;
    const box = el("div", "sm-diff-file");
    const head = el("div", "sm-diff-head");
    const label = el("span", "sm-label", f.name + " ");
    label.appendChild(el("span", "sm-grey", f.dir));
    head.appendChild(label);
    head.appendChild(CC.ui.numbers(f.add, f.del));
    const mark = el("button", "sm-viewed");
    mark.type = "button";
    mark.title = "Mark as viewed";
    mark.setAttribute("aria-label", "Mark as viewed");
    head.appendChild(mark);
    box.appendChild(head);
    const body = el("div", "sm-diff-body");
    f.lines.forEach(function (l) {
      body.appendChild(CC.devSample.lineEl(l[0], l[1], l[2]));
    });
    box.appendChild(body);
    function apply() {
      const seen = viewed.has(f.name);
      mark.classList.toggle("is-on", seen);
      mark.setAttribute("aria-pressed", String(seen));
      mark.replaceChildren();
      if (seen) {
        mark.appendChild(CC.ui.icon("check", 11));
      }
      body.hidden = seen;
    }
    mark.addEventListener("click", function () {
      if (viewed.has(f.name)) {
        viewed.delete(f.name);
      } else {
        viewed.add(f.name);
      }
      apply();
    });
    apply();
    return box;
  }

  CC.Panes.register("review", {
    fallback: true,
    title: function (ctx) {
      return "master to " + ctx.runtime.chat.branch;
    },
    mount: function (host, ctx) {
      const scroll = el("div", "sm-pane-scroll");
      const files = ctx.runtime.chat.diff || [];
      if (files.length === 0) {
        scroll.appendChild(el("div", "cc-empty", "This sample chat has no diff to show."));
      }
      files.forEach(function (f) {
        scroll.appendChild(fileEl(ctx, f));
      });
      host.appendChild(scroll);
      return {};
    },
  });
};
