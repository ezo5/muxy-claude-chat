// How busy the open chat's server is: CPU, memory and what uses them most. Not for this computer, which has its own tools. Asks only while the card is on screen.
CC.RailPerf = (function () {
  const el = CC.util.el;
  const EVERY_MS = 5000;
  const WARN = 75;
  const HIGH = 90;
  const GB = 1024 * 1024 * 1024;
  const MB = 1024 * 1024;
  // The last answer per server: a folded card's line, and what a chat switch shows at once.
  const latest = new Map();

  CC.icons.activity = '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>';

  function gb(bytes) {
    return (bytes / GB).toFixed(1);
  }

  function memOf(bytes) {
    return bytes >= GB ? gb(bytes) + " GB" : Math.round(bytes / MB) + " MB";
  }

  function pct(used, total) {
    return total > 0 ? Math.round(100 * used / total) : 0;
  }

  function statusOf(ctx) {
    const seen = ctx != null && ctx.runtime != null ? latest.get(CC.Servers.of(ctx.runtime).key) : null;
    return seen != null && seen.supported ? "CPU " + Math.round(seen.cpu) + "% · RAM " + pct(seen.memUsed, seen.memTotal) + "%" : null;
  }

  function meter(name) {
    const row = el("div", "cc-perf-meter");
    row.appendChild(el("span", "cc-perf-name", name));
    const value = el("span", "cc-perf-value");
    row.appendChild(value);
    const track = el("div", "cc-perf-track");
    const fill = el("div", "cc-perf-fill");
    track.appendChild(fill);
    row.appendChild(track);
    return {
      row: row,
      set: function (percent, text) {
        value.textContent = text;
        fill.style.width = Math.min(100, percent) + "%";
        // Judged on the whole number the card prints, so a bar never disagrees with its label.
        const shown = Math.round(percent);
        fill.classList.toggle("is-warn", shown > WARN && shown <= HIGH);
        fill.classList.toggle("is-high", shown > HIGH);
      },
    };
  }

  function processRow(p) {
    const row = el("div", "cc-perf-proc");
    const name = el("span", "cc-perf-proc-name", p.name);
    name.title = p.name + " (" + p.pid + ")";
    row.appendChild(name);
    row.appendChild(el("span", "cc-perf-proc-num", Math.round(p.cpu) + "%"));
    row.appendChild(el("span", "cc-perf-proc-num", memOf(p.mem)));
    return row;
  }

  function mount(host, ctx) {
    const server = CC.Servers.of(ctx.runtime);
    const root = el("div", "cc-perf");
    const cpu = meter("CPU");
    const ram = meter("RAM");
    const top = el("div", "cc-perf-top");
    const note = el("div", "cc-rail-note");
    note.hidden = true;
    root.appendChild(cpu.row);
    root.appendChild(ram.row);
    root.appendChild(top);
    root.appendChild(note);
    host.appendChild(root);
    let timer = null;
    let gone = false;

    function say(text) {
      note.textContent = text;
      note.hidden = false;
      cpu.row.hidden = true;
      ram.row.hidden = true;
      top.hidden = true;
    }

    function show(p) {
      if (!p.supported) {
        say("Not available on this server.");
        return;
      }
      note.hidden = true;
      cpu.row.hidden = false;
      ram.row.hidden = false;
      top.hidden = false;
      cpu.set(p.cpu, Math.round(p.cpu) + "% of " + p.cores + (p.cores === 1 ? " core" : " cores"));
      ram.set(pct(p.memUsed, p.memTotal), gb(p.memUsed) + " / " + gb(p.memTotal) + " GB");
      top.replaceChildren.apply(top, p.top.map(processRow));
    }

    function onScreen() {
      return root.offsetParent != null && document.visibilityState !== "hidden";
    }

    async function ask() {
      timer = null;
      if (onScreen()) {
        try {
          const p = await server.host.call("perf", {}, { timeoutMs: 8000 });
          if (gone) {
            return;
          }
          latest.set(server.key, p);
          show(p);
          CC.Rail.refresh();
        } catch (e) {
          if (gone) {
            return;
          }
          console.warn("performance not read", e && e.message);
          latest.delete(server.key);
          say("This server isn't answering.");
        }
      }
      if (!gone) {
        timer = setTimeout(ask, EVERY_MS);
      }
    }

    if (latest.has(server.key)) {
      show(latest.get(server.key));
    }
    ask();
    return {
      unmount: function () {
        gone = true;
        clearTimeout(timer);
      },
    };
  }

  CC.Rail.register("performance", {
    title: "Performance",
    icon: "activity",
    order: 60,
    visible: function (ctx) {
      return ctx != null && ctx.runtime != null && CC.Servers.of(ctx.runtime).local === false;
    },
    status: statusOf,
    mount: mount,
  });

  return { statusOf: statusOf };
})();
