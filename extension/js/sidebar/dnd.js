// Pointer drag and drop for the tree, without HTML5 DnD: its behaviour in WKWebView is unverified. An item has `data-drag` (kind), `data-id` and
// `data-scope` (where it may move), and a `data-drag-handle` where a press may start a drag. It moves only among items of its kind and scope.
CC.SidebarDnd = (function () {
  const THRESHOLD = 4;
  const EDGE = 28;
  const MAX_SPEED = 14;

  function passed(dx, dy) {
    return dx * dx + dy * dy >= THRESHOLD * THRESHOLD;
  }

  // Before the first item whose middle is below y, else after the last.
  function insertionIndex(rects, y) {
    for (let i = 0; i < rects.length; i++) {
      if (y < (rects[i].top + rects[i].bottom) / 2) {
        return i;
      }
    }
    return rects.length;
  }

  // `ids` with `id` moved to insertion index `to`, counted before the move. Null when nothing changes.
  function moveTo(ids, id, to) {
    const from = ids.indexOf(id);
    if (from < 0) {
      return null;
    }
    const out = ids.slice();
    out.splice(from, 1);
    out.splice(to > from ? to - 1 : to, 0, id);
    return out.join("\n") === ids.join("\n") ? null : out;
  }

  // `next` takes its new order in the slots its members already have among `all`; the others stay. `skip`: ids left out of the result.
  function mergeOrder(all, next, skip) {
    const members = new Set(next);
    let k = 0;
    return all.map(function (id) {
      return members.has(id) ? next[k++] : id;
    }).filter(function (id) {
      return !(skip != null && skip.has(id));
    });
  }

  function scrollStep(y, top, bottom) {
    if (y < top + EDGE) {
      return -Math.ceil(MAX_SPEED * Math.min(1, (top + EDGE - y) / EDGE));
    }
    if (y > bottom - EDGE) {
      return Math.ceil(MAX_SPEED * Math.min(1, (y - bottom + EDGE) / EDGE));
    }
    return 0;
  }

  // The list is flat: a project's block reaches to the next project's header, the last one to the next server's head or the end of the tree.
  function blockRects(items, scroller) {
    const rects = items.map(function (n) {
      const r = n.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, width: r.width };
    });
    if (items.length > 0 && items[0].dataset.drag === "project") {
      let next = items[items.length - 1].nextElementSibling;
      while (next != null && !next.classList.contains("sb-srv")) {
        next = next.nextElementSibling;
      }
      const end = next != null ? next.getBoundingClientRect().top : scroller.lastElementChild.getBoundingClientRect().bottom;
      rects.forEach(function (r, i) {
        r.bottom = i + 1 < rects.length ? rects[i + 1].top : Math.max(r.bottom, end);
      });
    }
    return rects;
  }

  // opts: {onDrop(kind, scope, ids), onEnd()}. → {active(), detach()}: the page must not redraw the tree during a drag.
  function attach(scroller, opts) {
    let press = null;
    let drag = null;
    let swallowing = false;

    function swallow(e) {
      e.preventDefault();
      e.stopPropagation();
    }

    function stopSwallowing() {
      if (swallowing) {
        swallowing = false;
        setTimeout(function () {
          window.removeEventListener("click", swallow, true);
        }, 0);
      }
    }

    function update() {
      drag.ghost.style.top = (drag.y - drag.offsetY) + "px";
      const rects = blockRects(drag.items, scroller);
      drag.index = insertionIndex(rects, drag.y);
      const y = drag.index < rects.length ? rects[drag.index].top : rects[rects.length - 1].bottom;
      drag.line.style.top = (y - 1) + "px";
      drag.line.style.left = rects[0].left + "px";
      drag.line.style.width = rects[0].width + "px";
    }

    function frame() {
      if (drag == null) {
        return;
      }
      const box = scroller.getBoundingClientRect();
      const d = scrollStep(drag.y, box.top, box.bottom);
      if (d !== 0) {
        const before = scroller.scrollTop;
        scroller.scrollTop = before + d;
        if (scroller.scrollTop !== before) {
          update();
        }
      }
      drag.raf = requestAnimationFrame(frame);
    }

    function start(e) {
      const item = press.item;
      const kind = item.dataset.drag;
      const scope = item.dataset.scope;
      const items = Array.prototype.filter.call(scroller.querySelectorAll("[data-drag]"), function (n) {
        return n.dataset.drag === kind && n.dataset.scope === scope;
      });
      const r = press.handle.getBoundingClientRect();
      const ghost = press.handle.cloneNode(true);
      ghost.classList.add("sb-ghost", "cc-floating");
      ghost.style.left = r.left + "px";
      ghost.style.width = r.width + "px";
      ghost.style.height = r.height + "px";
      const line = CC.util.el("div", "sb-drop-line");
      document.body.appendChild(ghost);
      document.body.appendChild(line);
      item.classList.add("sb-dragging");
      document.body.classList.add("sb-dnd-active");
      try {
        press.handle.setPointerCapture(press.pointerId);
      } catch (err) {
        console.warn("no pointer capture, the window still sees the moves", err && err.message);
      }
      window.addEventListener("click", swallow, true);
      swallowing = true;
      drag = { kind: kind, scope: scope, id: item.dataset.id, item: item, items: items, ghost: ghost, line: line, offsetY: press.y - r.top, y: e.clientY, index: null, raf: 0 };
      update();
      drag.raf = requestAnimationFrame(frame);
    }

    function finish(commit) {
      const d = drag;
      drag = null;
      press = null;
      if (d == null) {
        return;
      }
      cancelAnimationFrame(d.raf);
      d.ghost.remove();
      d.line.remove();
      d.item.classList.remove("sb-dragging");
      document.body.classList.remove("sb-dnd-active");
      const ids = d.items.map(function (n) {
        return n.dataset.id;
      });
      const next = commit && d.index != null ? moveTo(ids, d.id, d.index) : null;
      if (next != null) {
        opts.onDrop(d.kind, d.scope, next);
      }
      opts.onEnd();
    }

    function onDown(e) {
      if (e.button !== 0 || drag != null || e.target.closest == null) {
        return;
      }
      const handle = e.target.closest("[data-drag-handle]");
      const item = handle != null ? handle.closest("[data-drag]") : null;
      if (item != null && scroller.contains(item)) {
        press = { x: e.clientX, y: e.clientY, pointerId: e.pointerId, handle: handle, item: item };
      }
    }

    function onMove(e) {
      if (drag != null) {
        drag.y = e.clientY;
        update();
      } else if (press != null && e.pointerId === press.pointerId && passed(e.clientX - press.x, e.clientY - press.y)) {
        start(e);
      }
    }

    function onUp() {
      finish(true);
      stopSwallowing();
    }

    function onCancel() {
      finish(false);
      stopSwallowing();
    }

    function onKey(e) {
      if (drag != null && e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
        stopSwallowing();
      }
    }

    scroller.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);

    return {
      active: function () {
        return drag != null;
      },
      detach: function () {
        finish(false);
        scroller.removeEventListener("pointerdown", onDown);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, true);
      },
    };
  }

  return { passed: passed, insertionIndex: insertionIndex, moveTo: moveTo, mergeOrder: mergeOrder, scrollStep: scrollStep, attach: attach };
})();
