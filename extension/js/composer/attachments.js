// Images travel as base64 content blocks of the prompt, at most 2400 px, with a small preview for bubbles and queue rows. Other files upload
// to the server in exec-sized chunks and are mentioned as @path; paths dropped from a tree or editor just become @path.
CC.Composer.use(function (composer) {
  const util = CC.util;
  const el = util.el;
  const MAX_EDGE = 2400;
  const PREVIEW_EDGE = 480;
  const UPLOAD_CHUNK = 450000;
  let items = [];

  const row = el("div", "cmp-chip-row");
  composer.chips.appendChild(row);

  const picker = el("input");
  picker.type = "file";
  picker.multiple = true;
  picker.hidden = true;
  composer.root.appendChild(picker);

  composer.left.appendChild(composer.button("plus", "Attach images or files (or paste, drop)", function () {
    picker.click();
  }));

  picker.addEventListener("change", function () {
    Array.prototype.forEach.call(picker.files, add);
    picker.value = "";
  });

  composer.input.addEventListener("paste", function (e) {
    const dt = e.clipboardData;
    if (dt == null) {
      return;
    }
    const files = [];
    Array.prototype.forEach.call(dt.items || [], function (it) {
      const f = it.kind === "file" ? it.getAsFile() : null;
      if (f != null) {
        files.push(f);
      }
    });
    if (files.length > 0) {
      e.preventDefault();
      files.forEach(add);
    }
  });

  composer.box.addEventListener("dragover", function (e) {
    e.preventDefault();
    composer.box.classList.add("is-drop");
  });
  composer.box.addEventListener("dragleave", function () {
    composer.box.classList.remove("is-drop");
  });
  composer.box.addEventListener("drop", function (e) {
    e.preventDefault();
    composer.box.classList.remove("is-drop");
    const dt = e.dataTransfer;
    if (dt == null) {
      return;
    }
    const paths = droppedPaths(dt);
    if (paths.length > 0) {
      composer.focus();
      paths.forEach(mention);
      return;
    }
    const files = Array.prototype.slice.call(dt.files);
    const copies = files.filter(function (f) {
      return !/^image\//.test(f.type || "");
    });
    if (copies.length > 0) {
      CC.ui.toast("The webview hides local file paths, so " + (copies.length === 1 ? copies[0].name + " is" : copies.length + " files are") + " uploaded to the server and mentioned from there");
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
    const cwd = composer.cwd().replace(/\/+$/, "");
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

  // Small data URL kept with the message, so bubbles and queue rows can show the image.
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

  async function upload(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const base = (file.name || "file").replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40);
    const name = Date.now() + "-" + base + "." + extOf(file);
    let path = null;
    for (let i = 0; i < bytes.length || i === 0; i += UPLOAD_CHUNK) {
      const res = await CC.Servers.of(composer.runtime).host.call("writeImage", { name: name, b64: toBase64(bytes.subarray(i, i + UPLOAD_CHUNK)), append: i > 0 });
      path = res.path;
      if (bytes.length === 0) {
        break;
      }
    }
    return path;
  }

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
      CC.ui.toast("Attach failed: " + item.error, { level: "error" });
    }
    render();
  }

  function releaseThumb(item) {
    if (item.thumb != null && item.thumb !== item.preview) {
      URL.revokeObjectURL(item.thumb);
    }
  }

  function remove(item) {
    items = items.filter(function (x) {
      return x !== item;
    });
    releaseThumb(item);
    render();
  }

  function render() {
    row.textContent = "";
    items.forEach(function (it) {
      const chip = el("div", "cmp-chip cmp-attach" + (it.status === "error" ? " is-error" : ""));
      if (it.thumb != null) {
        const img = el("img");
        img.src = it.thumb;
        img.alt = it.label;
        chip.appendChild(img);
      } else {
        chip.appendChild(CC.ui.icon("file", 14));
        chip.appendChild(el("span", "cmp-chip-text", it.label));
      }
      if (it.status === "uploading") {
        chip.appendChild(el("span", "cc-spin"));
      }
      chip.title = it.status === "error" ? it.error : it.label;
      chip.appendChild(CC.ui.iconButton({
        icon: "x",
        label: "Remove " + it.label,
        size: 12,
        onClick: function () {
          remove(it);
        },
      }));
      row.appendChild(chip);
    });
    composer.refresh();
  }

  composer.on("beforeSubmit", function () {
    const loading = items.some(function (it) {
      return it.status === "uploading";
    });
    if (loading) {
      CC.ui.toast("Waiting for the attachment to load");
    }
    return loading;
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
    items.forEach(releaseThumb);
    items = [];
    render();
    return false;
  });

  composer.onDispose(function () {
    items.forEach(releaseThumb);
  });

  composer.restoreImages = function (images, previews) {
    (images || []).forEach(function (img, i) {
      const src = (previews || [])[i] || null;
      items.push({ id: util.uid(), kind: "image", label: "image", status: "ready", mediaType: img.media_type, b64: img.data, thumb: src, preview: src });
    });
    render();
  };
});
