// Alt+↑ / Alt+↓ jump between the user's prompts; older chunks load at the top.
CC.PromptNav = (function () {
  const GAP = 12;

  function PromptNav(flow) {
    this.flow = flow;
  }

  PromptNav.prototype.prompts = function () {
    return Array.prototype.filter.call(this.flow.log.querySelectorAll(".cv-user"), function (r) {
      return r.offsetParent !== null;
    });
  };

  PromptNav.prototype.top = function (row) {
    const s = this.flow.scroller;
    return row.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop;
  };

  // The nearest prompt above (dir -1) or below (dir 1) the top of the viewport.
  PromptNav.prototype.next = function (dir) {
    const at = this.flow.scroller.scrollTop;
    const self = this;
    const tops = this.prompts().map(function (r) {
      return { row: r, top: self.top(r) };
    });
    if (dir < 0) {
      return tops.filter(function (x) {
        return x.top < at - 1;
      }).pop() || null;
    }
    return tops.find(function (x) {
      return x.top > at + GAP + 1;
    }) || null;
  };

  PromptNav.prototype.go = async function (dir) {
    let hit = this.next(dir);
    for (let i = 0; hit == null && dir < 0 && this.flow.hasOlder && i < 20; i++) {
      await this.flow.requestOlder();
      hit = this.next(dir);
    }
    if (this.flow.parked) {
      return;
    }
    if (hit == null) {
      if (dir > 0) {
        this.flow.scrollToBottom(false);
      }
      return;
    }
    this.jump(hit.row);
  };

  PromptNav.prototype.jump = function (row) {
    this.flow.release();
    this.flow.scroller.scrollTop = Math.max(0, this.top(row) - GAP);
  };

  return PromptNav;
})();
