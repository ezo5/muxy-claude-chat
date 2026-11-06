CC.images = (function () {
  const el = CC.util.el;
  // Full images are megabytes of text, so only the last few stay; thumbnails are small copies and all stay.
  const KEPT_FULL = 6;
  const THUMB_SHORT_EDGE = 152;
  const cache = new Map();
  const thumbs = new Map();
  const visible = typeof IntersectionObserver === "function" ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) {
        visible.unobserve(e.target);
        e.target._load();
      }
    });
  }, { rootMargin: "300px" }) : null;

  async function fetchImage(file, id, n, server) {
    let data = "";
    let res;
    do {
      res = await server.host.call("image", { file: file, id: id, n: n, offset: data.length });
      data += res.data;
    } while (res.data !== "" && data.length < res.total);
    return "data:" + res.media + ";base64," + data;
  }

  function load(file, id, n, server) {
    const from = server || CC.Servers.focused();
    const key = from.key + "|" + file + "|" + id + "|" + n;
    const pending = cache.has(key) ? cache.get(key) : fetchImage(file, id, n, from).catch(function (e) {
      cache.delete(key);
      throw e;
    });
    cache.delete(key);
    cache.set(key, pending);
    if (cache.size > KEPT_FULL) {
      cache.delete(cache.keys().next().value);
    }
    return pending;
  }

  // A copy just big enough for the tile, so the flow doesn't keep and decode the full image.
  function shrink(src) {
    if (typeof createImageBitmap !== "function") {
      return Promise.resolve(src);
    }
    return new Promise(function (resolve) {
      const img = new Image();
      img.onload = function () {
        const scale = Math.min(1, THUMB_SHORT_EDGE / Math.min(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/png"));
      };
      img.onerror = function () {
        resolve(src);
      };
      img.src = src;
    });
  }

  function thumbOf(file, id, n) {
    const key = file + "|" + id + "|" + n;
    if (!thumbs.has(key)) {
      thumbs.set(key, load(file, id, n).then(shrink).catch(function (e) {
        thumbs.delete(key);
        throw e;
      }));
    }
    return thumbs.get(key);
  }

  function iconBtn(cls, name, title, fn) {
    const b = el("button", "lb-btn " + cls);
    b.type = "button";
    b.title = title;
    b.appendChild(CC.ui.icon(name));
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      fn();
    });
    return b;
  }

  // Images of one message: wheel / +/− zoom around the pointer, drag pans, click toggles fit and actual size,
  // ←/→ switch images, Esc or a click on the backdrop closes. `images` are functions returning a src promise.
  function lightbox(images, start, opener) {
    const box = el("div", "lightbox cc-layer cc-layer-dim");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.tabIndex = -1;
    const stage = el("div", "lb-stage");
    const img = el("img");
    img.alt = "";
    img.draggable = false;
    stage.appendChild(img);
    const bar = el("div", "lb-bar");
    const counter = el("span", "lb-count");
    const zoomLabel = el("span", "lb-zoom");
    bar.append(
      iconBtn("", "minus", "Zoom out (−)", function () {
        zoomBy(1 / 1.25);
      }),
      zoomLabel,
      iconBtn("", "plus", "Zoom in (+)", function () {
        zoomBy(1.25);
      }),
      iconBtn("", "maximize", "Fit / actual size (0)", function () {
        toggleFit(null);
      }),
    );
    const close = iconBtn("lightbox-close", "x", "Close (Esc)", done);
    const prev = iconBtn("lb-prev", "chevronLeft", "Previous image (←)", function () {
      show(index - 1);
    });
    const next = iconBtn("lb-next", "chevron", "Next image (→)", function () {
      show(index + 1);
    });
    box.append(stage, bar, close);
    if (images.length > 1) {
      box.append(prev, next);
      bar.insertBefore(counter, bar.firstChild);
    }

    let index = start;
    let seq = 0;
    let scale = 1;
    let fitScale = 1;
    let x = 0;
    let y = 0;
    let drag = null;

    function apply() {
      img.style.transform = "translate(" + x + "px, " + y + "px) scale(" + scale + ")";
      zoomLabel.textContent = Math.round(scale * 100) + "%";
      box.classList.toggle("zoomed", scale > fitScale + 0.001);
    }

    function fit() {
      const w = img.naturalWidth || 1;
      const h = img.naturalHeight || 1;
      fitScale = Math.min(1, (stage.clientWidth - 16) / w, (stage.clientHeight - 16) / h);
      scale = fitScale;
      x = (stage.clientWidth - w * scale) / 2;
      y = (stage.clientHeight - h * scale) / 2;
      apply();
    }

    function zoomAt(s, px, py) {
      const next = Math.min(8, Math.max(fitScale, s));
      x = px - (px - x) * (next / scale);
      y = py - (py - y) * (next / scale);
      scale = next;
      if (scale <= fitScale + 0.001) {
        fit();
        return;
      }
      apply();
    }

    function zoomBy(f) {
      zoomAt(scale * f, stage.clientWidth / 2, stage.clientHeight / 2);
    }

    function toggleFit(at) {
      const px = at != null ? at[0] : stage.clientWidth / 2;
      const py = at != null ? at[1] : stage.clientHeight / 2;
      if (scale > fitScale + 0.001) {
        fit();
      } else {
        zoomAt(Math.max(1, fitScale * 2), px, py);
      }
    }

    function show(i) {
      if (i < 0 || i >= images.length) {
        return;
      }
      index = i;
      const my = ++seq;
      counter.textContent = (i + 1) + " / " + images.length;
      prev.disabled = i === 0;
      next.disabled = i === images.length - 1;
      box.setAttribute("aria-label", images.length === 1 ? "Image" : "Image " + (i + 1) + " of " + images.length);
      box.classList.add("loading");
      images[i]().then(function (src) {
        if (my !== seq) {
          return;
        }
        img.onload = function () {
          box.classList.remove("loading");
          fit();
        };
        img.src = src;
      }, function (e) {
        if (my === seq) {
          box.classList.remove("loading");
          CC.ui.toast("Image not available: " + e.message, { level: "error" });
        }
      });
    }

    function done() {
      window.removeEventListener("resize", fit);
      box.remove();
      if (opener != null && opener.focus != null) {
        opener.focus();
      }
    }

    function local(e) {
      const r = stage.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    }

    stage.addEventListener("wheel", function (e) {
      e.preventDefault();
      const at = local(e);
      zoomAt(scale * Math.pow(1.0015, -e.deltaY * (e.deltaMode === 1 ? 30 : 1)), at[0], at[1]);
    }, { passive: false });
    stage.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) {
        return;
      }
      drag = { sx: e.clientX, sy: e.clientY, x: x, y: y, moved: false, onImg: e.target === img };
      stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener("pointermove", function (e) {
      if (drag == null) {
        return;
      }
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) {
        drag.moved = true;
      }
      if (drag.moved && scale > fitScale + 0.001) {
        x = drag.x + dx;
        y = drag.y + dy;
        apply();
      }
    });
    stage.addEventListener("pointerup", function (e) {
      const d = drag;
      drag = null;
      if (d == null || d.moved) {
        return;
      }
      if (d.onImg) {
        toggleFit(local(e));
      } else {
        done();
      }
    });
    box.addEventListener("keydown", function (e) {
      let handled = true;
      if (e.key === "Escape") {
        done();
      } else if (e.key === "ArrowLeft") {
        show(index - 1);
      } else if (e.key === "ArrowRight") {
        show(index + 1);
      } else if (e.key === "+" || e.key === "=") {
        zoomBy(1.25);
      } else if (e.key === "-") {
        zoomBy(1 / 1.25);
      } else if (e.key === "0") {
        fit();
      } else if (e.key === "1") {
        zoomAt(1, stage.clientWidth / 2, stage.clientHeight / 2);
      } else if (e.key !== "Tab") {
        handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
    window.addEventListener("resize", fit);
    document.body.appendChild(box);
    box.focus();
    show(start);
  }

  // Thumbnails of the image blocks of a transcript user entry, loaded once they scroll into view. `file()` is asked then, when the chat's
  // state is in. A tile that can't load says so and tries again on a click: the server may only have been away.
  function strip(file, id, count) {
    const row = el("div", "bubble-thumbs");
    const images = [];
    for (let n = 0; n < count; n++) {
      const k = n;
      images.push(function () {
        return load(file(), id, k);
      });
    }
    for (let n = 0; n < count; n++) {
      const k = n;
      const btn = el("button", "thumb loading");
      btn.type = "button";
      btn.title = "Open image";
      btn.setAttribute("aria-label", count === 1 ? "Image" : "Image " + (n + 1) + " of " + count);
      let ready = false;
      btn._load = function () {
        btn.classList.remove("failed");
        btn.classList.add("loading");
        btn.replaceChildren();
        thumbOf(file(), id, k).then(function (src) {
          const img = el("img");
          img.src = src;
          img.alt = "";
          btn.appendChild(img);
          btn.classList.remove("loading");
          btn.title = "Open image";
          ready = true;
        }, function (e) {
          btn.classList.replace("loading", "failed");
          btn.appendChild(CC.ui.icon("file"));
          btn.title = "Image not available: " + e.message + ". Click to try again";
        });
      };
      btn.addEventListener("click", function () {
        if (ready) {
          lightbox(images, k, btn);
        } else if (btn.classList.contains("failed")) {
          btn._load();
        }
      });
      if (visible != null) {
        visible.observe(btn);
      }
      row.appendChild(btn);
    }
    return row;
  }

  // Thumbnails from the composer's previews, for images sent from this runtime. The previews are small, so the viewer asks `full(n)` for the
  // original; when that's gone it shows the preview and says so.
  function local(previews, count, cls, full) {
    const row = el("div", cls);
    const shown = [];
    const shownAt = {};
    (previews || []).forEach(function (src, n) {
      if (src != null) {
        shownAt[n] = shown.length;
        shown.push(function () {
          return full(n).catch(function () {
            CC.ui.toast("The original image is no longer available, this is a small preview");
            return src;
          });
        });
      }
    });
    for (let n = 0; n < count; n++) {
      const src = (previews || [])[n] || null;
      const label = count === 1 ? "Image" : "Image " + (n + 1) + " of " + count;
      const btn = el("button", "thumb" + (src == null ? " failed" : ""));
      btn.type = "button";
      btn.setAttribute("aria-label", label);
      if (src != null) {
        const at = shownAt[n];
        const img = el("img");
        img.src = src;
        img.alt = "";
        btn.appendChild(img);
        btn.title = "Open image";
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          lightbox(shown, at, btn);
        });
      } else {
        btn.appendChild(CC.ui.icon("file"));
        btn.title = label;
      }
      row.appendChild(btn);
    }
    return row;
  }

  function open(src, opener) {
    lightbox([function () {
      return Promise.resolve(src);
    }], 0, opener);
  }

  return { strip: strip, local: local, load: load, open: open };
})();
