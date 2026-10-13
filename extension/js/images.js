window.CC = window.CC || {};

CC.images = (function () {
  const util = CC.util;
  const el = util.el;
  const cache = new Map();
  const visible = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) {
        visible.unobserve(e.target);
        e.target._load();
      }
    });
  }, { rootMargin: "300px" });

  async function fetchImage(file, id, n) {
    let data = "";
    let res;
    do {
      res = await CC.host.reader("image", { file: file, id: id, n: n, offset: data.length });
      data += res.data;
    } while (res.data !== "" && data.length < res.total);
    return "data:" + res.media + ";base64," + data;
  }

  function load(file, id, n) {
    const key = file + "|" + id + "|" + n;
    if (!cache.has(key)) {
      cache.set(key, fetchImage(file, id, n).catch(function (e) {
        cache.delete(key);
        throw e;
      }));
    }
    return cache.get(key);
  }

  function iconBtn(cls, name, title, fn) {
    const b = el("button", "lb-btn " + cls);
    b.type = "button";
    b.title = title;
    b.appendChild(util.icon(name));
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      fn();
    });
    return b;
  }

  // Images of one message: wheel / +/− zoom around the pointer, drag pans, click toggles fit and actual size,
  // ←/→ switch images, Esc or a click on the backdrop closes. `images` are functions returning a src promise.
  function lightbox(images, start, opener) {
    const box = el("div", "lightbox");
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
          util.toast("Image not available: " + e.message, "error");
        }
      });
    }

    function done() {
      window.removeEventListener("resize", fit);
      box.remove();
      opener.focus();
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

  // Thumbnails of the image blocks of a transcript user entry, loaded once they scroll into view.
  function strip(file, id, count) {
    const row = el("div", "bubble-thumbs");
    const images = [];
    for (let n = 0; n < count; n++) {
      const k = n;
      images.push(function () {
        return load(file, id, k);
      });
    }
    for (let n = 0; n < count; n++) {
      const k = n;
      const btn = el("button", "thumb loading");
      btn.type = "button";
      btn.title = "Open image";
      btn.setAttribute("aria-label", count === 1 ? "Image" : "Image " + (n + 1) + " of " + count);
      btn._load = function () {
        load(file, id, k).then(function (src) {
          const img = el("img");
          img.src = src;
          img.alt = "";
          btn.appendChild(img);
          btn.classList.remove("loading");
          btn.addEventListener("click", function () {
            lightbox(images, k, btn);
          });
        }, function (e) {
          btn.classList.replace("loading", "failed");
          btn.title = "Image not available: " + e.message;
        });
      };
      visible.observe(btn);
      row.appendChild(btn);
    }
    return row;
  }

  // Thumbnails of images not in the transcript yet (pending or queued), from the composer's previews.
  function local(previews, count, cls) {
    const row = el("div", cls);
    const srcs = (previews || []).filter(function (p) {
      return p != null;
    });
    const shown = srcs.map(function (src) {
      return function () {
        return Promise.resolve(src);
      };
    });
    for (let n = 0; n < count; n++) {
      const src = (previews || [])[n] || null;
      const label = count === 1 ? "Image" : "Image " + (n + 1) + " of " + count;
      const btn = el("button", "thumb" + (src == null ? " failed" : ""));
      btn.type = "button";
      btn.setAttribute("aria-label", label);
      if (src != null) {
        const at = srcs.indexOf(src);
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
        btn.appendChild(util.icon("file"));
        btn.title = label;
      }
      row.appendChild(btn);
    }
    return row;
  }

  return { strip: strip, local: local, load: load };
})();
