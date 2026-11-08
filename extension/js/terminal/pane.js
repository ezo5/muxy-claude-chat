// The `terminal` pane: xterm.js on one shell of CC.PageTerminals. Closing the pane leaves the shell running, as closing a chat's pane leaves the chat; its row stays in the sidebar.
(function () {
  const READ_WAIT_MS = 20000;
  const READ_CALL_MS = 25000;
  const RESIZE_DELAY_MS = 120;
  const RETRY_MS = 2000;
  const FONT_SIZE = 13;

  let xterm = null;

  // Half a megabyte nobody needs until the first terminal, so outside the bundle.
  function loadXterm() {
    if (xterm == null) {
      xterm = new Promise(function (resolve, reject) {
        const script = document.createElement("script");
        script.src = "js/xterm.js";
        script.onload = resolve;
        script.onerror = function () {
          xterm = null;
          reject(new Error("xterm.js didn't load"));
        };
        document.head.appendChild(script);
      });
    }
    return xterm;
  }

  function isToggleKey(e) {
    return e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.key === "`" || e.code === "Backquote");
  }

  // Cmd+K as in a Mac terminal: the screen and scrollback go, the prompt line stays on top.
  function isClearKey(e) {
    return e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === "k" || e.code === "KeyK");
  }

  function toBase64(bytes) {
    let text = "";
    for (let i = 0; i < bytes.length; i += 8192) {
      text += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }
    return btoa(text);
  }

  function fromBase64(text) {
    const raw = atob(text);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      bytes[i] = raw.charCodeAt(i);
    }
    return bytes;
  }

  // Through the element, as a colour token may be a color-mix() only the browser can work out.
  function themeOf(box) {
    const style = getComputedStyle(box);
    return { background: style.backgroundColor, foreground: style.color, cursor: style.color, selectionBackground: "rgba(128, 128, 128, 0.35)" };
  }

  function mount(body, ctx) {
    const id = ctx.params.id;
    // Panes saved before there were other servers name none.
    const server = ctx.params.server || "local";
    const box = document.createElement("div");
    box.className = "cc-term";
    body.appendChild(box);
    let term = null;
    let fit = null;
    let gone = false;
    let lastSize = null;
    let resizeTimer = null;
    let observer = null;
    let offTheme = null;
    let toSend = [];
    let sending = false;
    let failed = false;

    function ended() {
      gone = true;
      CC.PageTerminals.forget(id);
      CC.PageTerminals.call(server, { op: "close", id: id }).catch(function () {});
      ctx.shell.close(ctx.paneId);
    }

    async function send() {
      if (sending) {
        return;
      }
      sending = true;
      // Also after the pane closed: what was typed before that still goes to the shell.
      while (toSend.length > 0) {
        const parts = toSend;
        toSend = [];
        const bytes = new Uint8Array(parts.reduce(function (n, p) { return n + p.length; }, 0));
        let at = 0;
        parts.forEach(function (p) {
          bytes.set(p, at);
          at += p.length;
        });
        try {
          await CC.PageTerminals.call(server, { op: "write", id: id, data: toBase64(bytes) });
        } catch (e) {
          console.warn("terminal input lost", e && e.message);
        }
      }
      sending = false;
    }

    function syncSize() {
      if (term == null || gone || box.clientWidth === 0 || box.clientHeight === 0) {
        return;
      }
      fit.fit();
      const size = term.cols + "x" + term.rows;
      if (size !== lastSize) {
        lastSize = size;
        CC.PageTerminals.call(server, { op: "resize", id: id, cols: term.cols, rows: term.rows }).catch(function (e) {
          console.warn("terminal not resized", e && e.message);
        });
      }
    }

    // One answer written before the next is asked for, so a flood of output can't outrun the drawing: the host then skips what's too old, and Ctrl+C still gets through.
    async function pump() {
      let from = 0;
      while (!gone) {
        let answer = null;
        try {
          answer = await CC.PageTerminals.call(server, { op: "read", id: id, from: from, waitMs: READ_WAIT_MS }, READ_CALL_MS);
          failed = false;
        } catch (e) {
          if (gone) {
            return;
          }
          // Back from a reload before the servers are found: nothing to say yet.
          if (!failed && e.waiting !== true) {
            failed = true;
            term.write("\r\n\x1b[2m[" + String(e && e.message ? e.message : e) + "]\x1b[0m\r\n");
          }
          await CC.util.sleep(RETRY_MS);
          continue;
        }
        if (gone) {
          return;
        }
        if (answer.gone === true) {
          ended();
          return;
        }
        if (answer.data) {
          const bytes = fromBase64(answer.data);
          await new Promise(function (resolve) {
            term.write(bytes, resolve);
          });
        }
        from = answer.to;
        if (answer.exited === true) {
          ended();
          return;
        }
      }
    }

    function begin() {
      term = new window.Terminal({ fontFamily: getComputedStyle(box).fontFamily, fontSize: FONT_SIZE, scrollback: 5000, cursorBlink: true, minimumContrastRatio: 3, theme: themeOf(box) });
      fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open(box);
      // Ctrl+backtick is the app's, chat and its terminal back and forth.
      term.attachCustomKeyEventHandler(function (e) {
        if (isClearKey(e)) {
          if (e.type === "keydown") {
            term.clear();
          }
          return false;
        }
        return !isToggleKey(e);
      });
      term.onData(function (text) {
        toSend.push(new TextEncoder().encode(text));
        send();
      });
      // Mouse reports in the old encoding: bytes as characters, not text.
      term.onBinary(function (text) {
        toSend.push(Uint8Array.from(text, function (c) {
          return c.charCodeAt(0);
        }));
        send();
      });
      term.onTitleChange(function (title) {
        CC.PageTerminals.setTitle(id, title);
        ctx.setTitle();
      });
      offTheme = CC.host.theme.onChange(function () {
        term.options.theme = themeOf(box);
      });
      syncSize();
      const shown = ctx.shell.focused();
      if (shown != null && shown.id === ctx.paneId) {
        term.focus();
      }
      pump();
    }

    // Starts when it has a size: a pane is mounted before it's on the page.
    observer = new ResizeObserver(function () {
      if (box.clientWidth === 0 || box.clientHeight === 0 || gone) {
        return;
      }
      if (term == null) {
        if (!observer.loading) {
          observer.loading = true;
          loadXterm().then(function () {
            if (!gone) {
              begin();
            }
          }, function (e) {
            box.textContent = e.message;
          });
        }
        return;
      }
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(syncSize, RESIZE_DELAY_MS);
    });
    observer.observe(box);

    return {
      focus: function () {
        if (term != null) {
          term.focus();
        }
      },
      // In a chat's terminal: back to that chat, which asks first if Claude still runs.
      onKey: function (e) {
        const chat = isToggleKey(e) ? CC.Chats.chatOfPane(id) : null;
        if (chat == null) {
          return false;
        }
        CC.Chats.open(chat).toChat().catch(function (err) {
          CC.ui.toast("Couldn't return to the chat: " + (err && err.message ? err.message : err), { level: "error" });
        });
        return true;
      },
      unmount: function () {
        gone = true;
        clearTimeout(resizeTimer);
        observer.disconnect();
        if (offTheme != null) {
          offTheme();
        }
        if (term != null) {
          term.dispose();
        }
      },
    };
  }

  CC.Panes.register("terminal", {
    title: function (ctx) {
      return CC.PageTerminals.title(ctx.params.id);
    },
    mount: mount,
  });
})();
