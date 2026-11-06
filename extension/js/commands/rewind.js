// Rewind and edit of a prompt: rewind_conversation drops the prompt and everything after it in the running CLI, rewind_files restores the
// files Claude touched since (file checkpoints). What's running is kept on the runtime, so two chats on screen don't share it.
//   CC.Rewind.target(item) → the prompt's CLI uuid or null
//   CC.Rewind.available(runtime, item) → bool: whether a prompt's icons show; only while the chat is idle, in chat mode
//   CC.Rewind.open(runtime, item) → the dialog
//   CC.Rewind.edit(runtime, item, {composer}) → rewinds to before the prompt and puts it back in the field; a running turn is interrupted first
CC.Rewind = (function () {
  const el = CC.util.el;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  function target(item) {
    if (item.k !== "user" || item.command === true || item.agent != null) {
      return null;
    }
    if (item.uuid) {
      return item.uuid;
    }
    return item.queued !== true && UUID.test(String(item.id)) ? item.id : null;
  }

  function available(runtime, item) {
    return target(item) != null && runtime.status() === "idle" && runtime.mode() === "chat" && runtime.rewinding !== true;
  }

  function ready(runtime) {
    if (runtime.rewinding === true) {
      CC.Commands.toast("A rewind is already running");
      return false;
    }
    if (runtime.status() !== "idle") {
      CC.Commands.toast("Rewind works while Claude is idle. Interrupt it or wait for the turn to end");
      return false;
    }
    return true;
  }

  // last_seen_user_message_uuid: without it the CLI refuses a target that has later prompts ("stale_target").
  function lastSeen(runtime) {
    const items = runtime.store.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const uuid = target(items[i]);
      if (uuid != null) {
        return uuid;
      }
    }
    return null;
  }

  async function rewindConversation(runtime, uuid) {
    const r = await CC.Commands.control(runtime, "rewind_conversation", { target_message_uuid: uuid, last_seen_user_message_uuid: lastSeen(runtime) });
    if (r.rewound !== true) {
      throw new Error(r.error || r.reason || "the conversation was not rewound");
    }
    Promise.resolve(runtime.control("get_context_usage", { detail: "summary" })).catch(function () {});
    return r;
  }

  async function run(runtime, uuid, conversation, code) {
    runtime.rewinding = true;
    let restored = false;
    try {
      if (code) {
        const r = await CC.Commands.control(runtime, "rewind_files", { user_message_id: uuid });
        if (r.canRewind !== true) {
          throw new Error(r.error || "files could not be restored");
        }
        restored = true;
      }
      if (conversation) {
        await rewindConversation(runtime, uuid);
      }
      CC.Commands.toast(conversation && code ? "Rewound the conversation and the code" : conversation ? "Rewound the conversation" : "Restored the code");
    } catch (e) {
      CC.Commands.toast((restored ? "Code restored, but the conversation rewind failed: " : "Rewind failed: ") + e.message, "error");
    } finally {
      runtime.rewinding = false;
    }
  }

  const CHOICES = [
    { label: "Conversation and code", text: "Back to before this prompt, files restored.", conversation: true, code: true },
    { label: "Conversation only", text: "Files stay as they are now.", conversation: true, code: false },
    { label: "Code only", text: "The conversation stays, files go back.", conversation: false, code: true },
  ];

  // The dialog's body and the state behind its Restore choice. Keys 1-3 pick and go, as in the menu it replaces.
  function dialogBody(item) {
    const body = el("div", "cc-rewind");
    const quote = el("div", "cc-rewind-quote", CC.util.firstLine(item.text, 200) || "(image)");
    const group = el("div", "cc-rewind-choices");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", "Restore");
    const name = "cc-rewind-" + CC.util.uid();
    const state = { selected: 1, rows: [] };
    function select(i) {
      state.selected = i;
      state.rows.forEach(function (r, k) {
        r.input.checked = k === i;
        r.label.classList.toggle("is-chosen", k === i);
      });
    }
    CHOICES.forEach(function (c, i) {
      const label = el("label", "cc-rewind-choice");
      const input = el("input");
      input.type = "radio";
      input.name = name;
      input.disabled = c.code === true;
      input.addEventListener("change", function () {
        select(i);
      });
      const words = el("span", "cc-rewind-words");
      words.append(el("span", "cc-rewind-label", c.label), el("span", "cc-rewind-text", c.text));
      label.append(input, words, el("kbd", null, String(i + 1)));
      group.appendChild(label);
      state.rows.push({ label: label, input: input, choice: c });
    });
    const files = el("div", "cc-rewind-files", "Checking files…");
    const caveat = el("div", "cc-rewind-caveat", "Claude forgets this prompt and everything after it. Only files Claude changed can be restored; changes you made outside it stay.");
    body.append(quote, group, files, caveat);
    select(1);
    state.body = body;
    state.files = files;
    state.select = select;
    return state;
  }

  function usable(state) {
    return state.rows.map(function (r, i) {
      return i;
    }).filter(function (i) {
      const r = state.rows[i];
      return !r.input.disabled && !r.label.hidden;
    });
  }

  function dryRun(runtime, uuid, state) {
    function unavailable(text) {
      state.files.textContent = text;
      state.rows.forEach(function (r) {
        if (r.choice.code === true) {
          r.label.hidden = true;
        }
      });
    }
    CC.Commands.control(runtime, "rewind_files", { user_message_id: uuid, dry_run: true }).then(function (r) {
      const n = (r.filesChanged || []).length;
      if (r.canRewind !== true) {
        unavailable("Code rewind unavailable: " + (r.error || "no file checkpoints"));
        return;
      }
      if (n === 0) {
        unavailable("No file changes to restore since this prompt.");
        return;
      }
      state.files.replaceChildren(document.createTextNode(n + (n === 1 ? " file " : " files ")), CC.ui.numbers(r.insertions || 0, r.deletions || 0));
      state.files.title = r.filesChanged.join("\n");
      state.rows.forEach(function (row) {
        row.input.disabled = false;
      });
    }, function (e) {
      unavailable("Code rewind unavailable: " + e.message);
    });
  }

  function dialogKeys(box, state) {
    box.addEventListener("keydown", function (e) {
      const can = usable(state);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const at = can.indexOf(state.selected);
        state.select(can[(at + (e.key === "ArrowDown" ? 1 : can.length - 1)) % can.length]);
      } else if (/^[1-3]$/.test(e.key) && can.indexOf(Number(e.key) - 1) >= 0) {
        state.select(Number(e.key) - 1);
        box.querySelector(".cc-btn-primary").click();
      } else {
        return;
      }
      e.preventDefault();
    });
  }

  async function open(runtime, item) {
    const uuid = target(item);
    if (uuid == null || !ready(runtime)) {
      return;
    }
    const state = dialogBody(item);
    const answer = CC.ui.dialog({
      title: "Rewind to here",
      body: state.body,
      buttons: [{ label: "Cancel", value: null }, { label: "Rewind", primary: true, value: "go" }],
    });
    dialogKeys(state.body.parentElement, state);
    dryRun(runtime, uuid, state);
    if ((await answer) !== "go" || !ready(runtime)) {
      return;
    }
    const c = CHOICES[state.selected];
    await run(runtime, uuid, c.conversation, c.code);
  }

  function idle(runtime, timeoutMs) {
    if (runtime.status() === "idle") {
      return Promise.resolve();
    }
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        off();
        reject(new Error("Claude did not stop in time"));
      }, timeoutMs);
      const off = runtime.on("state", function () {
        if (runtime.status() === "idle") {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
    });
  }

  async function readImage(server, file, uuid, n) {
    let data = "";
    let res;
    do {
      res = await server.host.call("image", { file: file, id: uuid, n: n, offset: data.length });
      data += res.data;
    } while (res.data !== "" && data.length < res.total);
    return { media_type: res.media, data: data };
  }

  function images(runtime, uuid, count) {
    const file = runtime.transcriptFile();
    const out = [];
    for (let n = 0; n < count; n++) {
      out.push(readImage(CC.Servers.of(runtime), file, uuid, n));
    }
    return Promise.all(out).catch(function (e) {
      throw new Error("images could not be read back: " + e.message);
    });
  }

  async function edit(runtime, item, opts) {
    const uuid = target(item);
    if (uuid == null) {
      return;
    }
    const st = runtime.status();
    const busy = st === "busy" || st === "waiting";
    if (busy && runtime.rewinding === true) {
      CC.Commands.toast("A rewind is already running");
      return;
    }
    if (!busy && !ready(runtime)) {
      return;
    }
    runtime.rewinding = true;
    try {
      if (busy) {
        await runtime.interrupt();
        await idle(runtime, 15000);
      }
      const pics = await images(runtime, uuid, item.images || 0);
      const r = await rewindConversation(runtime, uuid);
      const text = r.prefillText != null ? r.prefillText : item.text;
      const composer = (opts != null ? opts.composer : null) || runtime.composer;
      if (composer == null) {
        await CC.util.copyText(text);
        CC.Commands.toast("Rewound. The prompt is on the clipboard");
        return;
      }
      const cur = composer.value().trim();
      composer.setValue(text + (cur !== "" ? "\n\n" + cur : ""));
      if (pics.length > 0) {
        composer.restoreImages(pics, pics.map(function (img) {
          return "data:" + img.media_type + ";base64," + img.data;
        }));
      }
      composer.focus();
    } catch (e) {
      CC.Commands.toast("Edit failed: " + e.message, "error");
    } finally {
      runtime.rewinding = false;
    }
  }

  return { target: target, available: available, ready: ready, open: open, edit: edit };
})();

// `/rewind`: pick one of the loaded prompts, then the same dialog as the prompt's icon.
CC.Commands.add("rewind", function (ctx) {
  const runtime = ctx.runtime;
  if (!CC.Rewind.ready(runtime)) {
    return;
  }
  const items = runtime.store.items.filter(function (it) {
    return CC.Rewind.target(it) != null;
  }).reverse();
  const body = ctx.card.open("rewind", "Rewind to", "Claude forgets the prompt and everything after it");
  ctx.card.list(body, items.map(function (it) {
    return {
      label: CC.util.firstLine(it.text, 200) || "(image)",
      sub: it.ts ? new Date(it.ts).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "",
      item: it,
    };
  }), {
    search: "Filter prompts",
    empty: "No prompts to rewind to in this conversation",
    action: "rewind",
    onPick: function (it) {
      CC.Rewind.open(runtime, it.item);
    },
  });
});
