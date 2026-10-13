window.CC = window.CC || {};

CC.Composer.use(function (composer) {
  const util = CC.util;
  const el = util.el;
  const MAX_EDGE = 2400;
  const PREVIEW_EDGE = 480;
  const UPLOAD_CHUNK = 450000;
  let items = [];

  const picker = el("input");
  picker.type = "file";
  picker.multiple = true;
  picker.style.display = "none";
  composer.root.appendChild(picker);

  const btn = composer.button("paperclip", "Attach images or files (or paste / drop)", function () {
    picker.click();
  });
  composer.left.insertBefore(btn, composer.left.firstChild);

  picker.addEventListener("change", function () {
    Array.prototype.forEach.call(picker.files, add);
    picker.value = "";
  });

  composer.input.addEventListener("paste", function (e) {
    const files = [];
    const dt = e.clipboardData;
    if (dt == null) {
      return;
    }
    Array.prototype.forEach.call(dt.items || [], function (it) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f != null) {
          files.push(f);
        }
      }
    });
    if (files.length > 0) {
      e.preventDefault();
      files.forEach(add);
    }
  });

  composer.box.addEventListener("dragover", function (e) {
    e.preventDefault();
    composer.box.classList.add("drop");
  });
  composer.box.addEventListener("dragleave", function () {
    composer.box.classList.remove("drop");
  });
  composer.box.addEventListener("drop", function (e) {
    e.preventDefault();
    composer.box.classList.remove("drop");
    const dt = e.dataTransfer;
    if (dt == null) {
      return;
    }
    const paths = droppedPaths(dt);
    if (paths.length > 0) {
      composer.input.focus();
      paths.forEach(mention);
      return;
    }
    const files = Array.prototype.slice.call(dt.files);
    const copies = files.filter(function (f) {
      return !/^image\//.test(f.type || "");
    });
    if (copies.length > 0) {
      util.toast("The webview hides local file paths, so " + (copies.length === 1 ? copies[0].name + " is" : copies.length + " files are") + " uploaded to the server and mentioned from /tmp");
    }
    files.forEach(add);
  });

  // Drags from a file tree or an editor carry file:// URIs or plain absolute paths; OS file drags only carry blobs.
  function droppedPaths(dt) {
    const uris = (dt.getData("text/uri-list") || "").split(/\r?\n/).filter(function (l) {
      return /^file:\/\//.test(l);
    }).map(function (l) {
      return decodeURIComponent(l.replace(/^file:\/\/[^/]*/, ""));
    });
    if (uris.length > 0) {
      return uris;
    }
    const lines = (dt.getData("text/plain") || "").split(/\r?\n/).map(function (l) {
      return l.trim();
    }).filter(Boolean);
    return lines.length > 0 && lines.every(function (l) {
      return /^(~|\/[^/]*)\/./.test(l);
    }) ? lines : [];
  }

  function mention(path) {
    const cwd = (composer.meta.cwd || "").replace(/\/+$/, "");
    const rel = cwd && path.indexOf(cwd + "/") === 0 ? path.slice(cwd.length + 1) : path;
    const before = composer.value().slice(0, composer.input.selectionStart);
    composer.insertAtCaret((/\S$/.test(before) ? " " : "") + "@" + (/\s/.test(rel) ? '"' + rel + '"' : rel) + " ");
  }

  async function shrink(file) {
    if (typeof createImageBitmap !== "function" || file.type === "image/gif") {
      return file;
    }
    let bmp;
    try {
      bmp = await createImageBitmap(file);
    } catch (e) {
      return file;
    }
    const edge = Math.max(bmp.width, bmp.height);
    if (edge <= MAX_EDGE && file.size < 3500000) {
      return file;
    }
    const scale = Math.min(1, MAX_EDGE / edge);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const type = file.type === "image/png" ? "image/png" : "image/jpeg";
    return new Promise(function (resolve) {
      canvas.toBlob(function (blob) {
        resolve(blob || file);
      }, type, 0.9);
    });
  }

  // Small data URL kept with the message, so pending and queued bubbles (and a reloaded queue) can show the image.
  async function preview(blob) {
    if (typeof createImageBitmap !== "function") {
      return null;
    }
    try {
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, PREVIEW_EDGE / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.8);
    } catch (e) {
      return null;
    }
  }

  function toBase64(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  function extOf(file) {
    const m = /\.([A-Za-z0-9]+)$/.exec(file.name || "");
    if (m != null) {
      return m[1].toLowerCase();
    }
    return ((file.type || "").split("/")[1] || "bin").replace(/[^a-z0-9]/g, "");
  }

  // Other files go to /tmp/claude-chat-images/ on the server in exec-sized chunks and are referenced as @path.
  async function upload(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const base = (file.name || "file").replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40);
    const name = Date.now() + "-" + base + "." + extOf(file);
    let path = null;
    for (let i = 0; i < bytes.length || i === 0; i += UPLOAD_CHUNK) {
      const res = await CC.host.reader("writeImage", { name: name, b64: toBase64(bytes.subarray(i, i + UPLOAD_CHUNK)), append: i > 0 });
      path = res.path;
      if (bytes.length === 0) {
        break;
      }
    }
    return path;
  }

  // Images travel as base64 content blocks of the prompt; other files are uploaded and mentioned.
  async function add(file) {
    const isImage = /^image\//.test(file.type || "");
    const item = { id: util.uid(), kind: isImage ? "image" : "file", label: file.name || (isImage ? "pasted image" : "file"), status: "uploading", thumb: isImage ? URL.createObjectURL(file) : null };
    items.push(item);
    render();
    try {
      if (!isImage) {
        const path = await upload(file);
        items = items.filter(function (x) {
          return x !== item;
        });
        mention(path);
        render();
        return;
      }
      const blob = await shrink(file);
      item.mediaType = blob.type || file.type;
      item.b64 = toBase64(new Uint8Array(await blob.arrayBuffer()));
      item.preview = await preview(blob);
      item.status = "ready";
    } catch (e) {
      item.status = "error";
      item.error = e && e.message ? e.message : String(e);
      util.toast("Attach failed: " + item.error, "error");
    }
    render();
  }

  function remove(item) {
    items = items.filter(function (x) {
      return x !== item;
    });
    if (item.thumb != null && item.thumb !== item.preview) {
      URL.revokeObjectURL(item.thumb);
    }
    render();
  }

  function render() {
    const row = composer.attachRow;
    row.textContent = "";
    items.forEach(function (it) {
      const chip = el("div", "attach " + it.status);
      if (it.thumb != null) {
        const img = el("img");
        img.src = it.thumb;
        chip.appendChild(img);
      } else {
        chip.appendChild(util.icon("file"));
        chip.appendChild(el("span", "attach-name", it.label));
      }
      if (it.status === "uploading") {
        chip.appendChild(el("span", "attach-spinner"));
      }
      chip.title = it.status === "error" ? it.error : it.label;
      const x = el("button", "attach-x");
      x.type = "button";
      x.appendChild(util.icon("x"));
      x.addEventListener("click", function () {
        remove(it);
      });
      chip.appendChild(x);
      row.appendChild(chip);
    });
    row.classList.toggle("hidden", items.length === 0);
    composer.refresh();
  }

  composer.on("beforeSubmit", function () {
    if (items.some(function (it) {
      return it.status === "uploading";
    })) {
      util.toast("Waiting for the attachment to load…");
      return true;
    }
    return false;
  });

  composer.on("collect", function (entry) {
    const ready = items.filter(function (it) {
      return it.status === "ready" && it.kind === "image";
    });
    entry.images = ready.map(function (it) {
      return { media_type: it.mediaType, data: it.b64 };
    });
    entry.previews = ready.map(function (it) {
      return it.preview || null;
    });
    return false;
  });

  composer.on("submitted", function () {
    items.forEach(function (it) {
      if (it.thumb != null && it.thumb !== it.preview) {
        URL.revokeObjectURL(it.thumb);
      }
    });
    items = [];
    render();
    return false;
  });

  composer.restoreImages = function (images, previews) {
    (images || []).forEach(function (img, i) {
      const src = (previews || [])[i] || null;
      items.push({ id: util.uid(), kind: "image", label: "image", status: "ready", mediaType: img.media_type, b64: img.data, thumb: src, preview: src });
    });
    render();
  };

  render();
});
