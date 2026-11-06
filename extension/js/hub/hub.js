// A server's one long poll: all its chats, mirrors, its overview and chat requests share one `watch` at a time. Every server with chats has its own.
CC.Hub = (function () {
  const PROTOCOL = 1;
  const TIMEOUT_MS = 25000;
  const EXEC_MARGIN_MS = 15000;
  const RETRY_MS = [700, 1500, 5000];
  const EMPTY_REPLY_PAUSE_MS = 1000;

  function make(server) {
    let started = false;
    let stopped = false;
    let helloDone = false;
    let down = false;
    let current = null;
    let wake = null;
    const subs = new Set();
    const mirrors = new Map();

    let overviewVersion = null;
    let rows = [];
    const overviewFns = new Set();

    const seenRequests = new Set();
    const unheard = [];
    const requestFns = new Set();

    function guarded(fn, payload) {
      try {
        fn(payload);
      } catch (e) {
        console.error("hub listener failed", e);
      }
    }

    // The state's big parts this reader holds, by the server's hash of each.
    function partHashes(s) {
      const out = {};
      Object.keys(s.parts).forEach(function (key) {
        out[key] = s.parts[key].hash;
      });
      return out;
    }

    // A second reader of one chat may start further back, so the request asks from the lowest cursor and each reader gets its own part.
    // A part is named only when every reader holds it, as the server then leaves it out for all of them.
    function sessionParams() {
      const out = {};
      subs.forEach(function (s) {
        const have = out[s.sid];
        const parts = partHashes(s);
        if (have == null) {
          out[s.sid] = { after: s.after, stateVersion: s.stateVersion, topicAt: s.topicAt };
          if (Object.keys(parts).length > 0) {
            out[s.sid].parts = parts;
          }
        } else {
          Object.keys(have.parts || {}).forEach(function (key) {
            if (have.parts[key] !== parts[key]) {
              delete have.parts[key];
            }
          });
          have.after = Math.min(have.after, s.after);
          have.stateVersion = Math.min(have.stateVersion, s.stateVersion);
          have.topicAt = Math.min(have.topicAt, s.topicAt);
        }
      });
      return out;
    }

    function mirrorParams() {
      const out = {};
      mirrors.forEach(function (m, key) {
        out[key] = m.params;
      });
      return out;
    }

    function request() {
      return {
        overviewVersion: overviewVersion,
        sessions: sessionParams(),
        mirrors: mirrorParams(),
        requestsSeen: Array.from(seenRequests),
        // While down the next reply says the server is back, so it can't wait for news.
        timeoutMs: down ? 0 : TIMEOUT_MS,
      };
    }

    // The whole state again from a reply and what this reader holds. Null when a part is missing: the next call then asks for everything.
    function wholeState(s, entry) {
      const state = Object.assign({}, entry.state);
      const hashes = entry.parts || {};
      const kept = {};
      const whole = Object.keys(hashes).every(function (key) {
        if (state[key] === undefined) {
          if (s.parts[key] == null) {
            return false;
          }
          state[key] = s.parts[key].value;
        }
        kept[key] = { hash: hashes[key], value: state[key] };
        return true;
      });
      s.parts = whole ? kept : {};
      if (!whole) {
        s.stateVersion = 0;
      }
      return whole ? state : null;
    }

    // On copies, as a listener may subscribe again from inside its call.
    function applySession(sid, entry) {
      Array.from(subs).forEach(function (s) {
        if (s.sid !== sid) {
          return;
        }
        const events = (entry.events || []).filter(function (e) {
          return e.seq > s.after;
        });
        if (events.length > 0) {
          s.after = events[events.length - 1].seq;
        }
        const state = entry.state != null && entry.state.version !== s.stateVersion ? wholeState(s, entry) : null;
        if (state != null) {
          s.stateVersion = state.version;
        }
        if (entry.topicAt != null) {
          s.topicAt = entry.topicAt;
        }
        if (events.length > 0 || state != null || entry.topicAt != null) {
          guarded(s.onBatch, { events: events, state: state, more: entry.more === true, topic: entry.topic, topicAt: entry.topicAt });
        }
      });
    }

    // The reader's cursor moves here, and an owner that subscribes again with the new cursor changes nothing.
    function applyMirror(key, reply) {
      const m = mirrors.get(key);
      if (m == null) {
        return;
      }
      ["watch", "file", "offset"].forEach(function (k) {
        if (reply[k] !== undefined) {
          m.params[k] = reply[k];
        }
      });
      guarded(m.onPoll, reply);
    }

    function hearRequests(list) {
      list.forEach(function (r) {
        if (seenRequests.has(r.id)) {
          return;
        }
        seenRequests.add(r.id);
        if (requestFns.size === 0) {
          unheard.push(r);
        }
        requestFns.forEach(function (fn) {
          guarded(fn, r);
        });
      });
    }

    function rowsWith(changes) {
      const replaced = new Set(changes.removed);
      changes.rows.forEach(function (r) {
        replaced.add(r.sessionId);
      });
      return rows.filter(function (r) {
        return !replaced.has(r.sessionId);
      }).concat(changes.rows).sort(function (a, b) {
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
    }

    function apply(reply) {
      overviewVersion = reply.overviewVersion;
      if (reply.overview != null || reply.overviewChanges != null) {
        rows = reply.overview != null ? reply.overview : rowsWith(reply.overviewChanges);
        overviewFns.forEach(function (fn) {
          guarded(fn, rows);
        });
      }
      const sessions = reply.sessions || {};
      Object.keys(sessions).forEach(function (sid) {
        applySession(sid, sessions[sid]);
      });
      const polled = reply.mirrors || {};
      Object.keys(polled).forEach(function (key) {
        applyMirror(key, polled[key]);
      });
      hearRequests(reply.requests || []);
    }

    function isEmpty(reply) {
      return reply.overview == null && reply.overviewChanges == null && reply.more !== true && (reply.requests || []).length === 0 &&
        Object.keys(reply.sessions || {}).length === 0 && Object.keys(reply.mirrors || {}).length === 0;
    }

    // A kick ends the wait early.
    function pause(ms) {
      return new Promise(function (resolve) {
        const timer = setTimeout(done, ms);
        function done() {
          clearTimeout(timer);
          wake = null;
          resolve();
        }
        wake = done;
      });
    }

    function report(isDown, why) {
      if (isDown) {
        CC.Servers.markDown(server.key, why);
      }
      if (isDown !== down) {
        down = isDown;
        if (!isDown) {
          CC.Servers.markUp(server.key);
        }
        CC.bus.emit(isDown ? "server:down" : "server:up", { server: server.key });
      }
    }

    async function hello() {
      const found = await server.host.probe();
      const claude = found != null ? found.claude : null;
      const reply = await server.host.call("hello", claude != null ? { claudeBin: claude.path, claudeVersion: claude.version } : {});
      if (reply.protocol !== PROTOCOL) {
        stopped = true;
        const text = "This Claude Chat speaks protocol " + PROTOCOL + " and its server " + reply.protocol + ". This is a bug, please report it.";
        // One server's trouble, unless it's the only one the page has.
        if (server.key === CC.Servers.TAB) {
          CC.fatal(text);
        } else {
          CC.Servers.markDown(server.key, text);
        }
      }
      helloDone = true;
    }

    // Resolves when the job settles or a kick drops it. A reply after a kick is ignored: its cursors never moved, so nothing is lost.
    function runWatch() {
      const sent = request();
      const job = server.host.job("watch", sent, { timeoutMs: TIMEOUT_MS + EXEC_MARGIN_MS });
      const run = { job: job, mirrors: sent.mirrors };
      return new Promise(function (resolve) {
        run.drop = function () {
          resolve({ kicked: true });
        };
        current = run;
        job.result.then(function (reply) {
          resolve({ reply: reply });
        }, function (error) {
          resolve({ error: error });
        });
      }).then(function (outcome) {
        current = null;
        return outcome;
      });
    }

    // A server without chats has nothing to watch, and starts no Python for it.
    async function nothingToWatch() {
      try {
        return CC.probeCore.noChats(await server.host.probe());
      } catch (e) {
        return false;
      }
    }

    async function loop() {
      if (await nothingToWatch()) {
        return;
      }
      let failures = 0;
      while (!stopped) {
        const at = Date.now();
        let outcome = null;
        try {
          if (!helloDone) {
            await hello();
            if (stopped) {
              return;
            }
          }
          outcome = await runWatch();
        } catch (e) {
          outcome = { error: e };
        }
        if (outcome.kicked) {
          continue;
        }
        // Muxy had no room for it, which says nothing about the server.
        if (outcome.error != null && outcome.error.busy === true) {
          await pause(RETRY_MS[0]);
          continue;
        }
        if (outcome.error != null) {
          console.warn("watch failed:", outcome.error.message || outcome.error);
          report(true, outcome.error.message || String(outcome.error));
          await pause(RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]);
          failures += 1;
          continue;
        }
        failures = 0;
        report(false);
        apply(outcome.reply);
        // A server that says nothing right away would make this loop spin.
        if (isEmpty(outcome.reply) && Date.now() - at < EMPTY_REPLY_PAUSE_MS) {
          await pause(EMPTY_REPLY_PAUSE_MS);
        }
      }
    }

    function start() {
      if (started) {
        return;
      }
      started = true;
      loop();
    }

    function stop() {
      stopped = true;
      kick();
    }

    function kick() {
      if (current != null) {
        const run = current;
        current = null;
        run.drop();
        run.job.cancel();
      } else if (wake != null) {
        wake();
      }
    }

    function subscribe(sid, from, onBatch) {
      const s = {
        sid: sid,
        after: from != null && from.after != null ? from.after : 0,
        stateVersion: from != null && from.stateVersion != null ? from.stateVersion : 0,
        topicAt: from != null && from.topicAt != null ? from.topicAt : 0,
        parts: {},
        onBatch: onBatch,
      };
      subs.add(s);
      kick();
      return function () {
        subs.delete(s);
      };
    }

    // One mirror per key: subscribing again replaces it, and a stale unsubscribe leaves the new one alone. The running call need not
    // restart when it already asks exactly this, which is the case for an owner re-subscribing from a reply.
    function mirror(key, params, onPoll) {
      const m = { params: Object.assign({}, params), onPoll: onPoll };
      mirrors.set(key, m);
      const asked = current != null ? current.mirrors[key] : null;
      if (asked == null || JSON.stringify(asked) !== JSON.stringify(m.params)) {
        kick();
      }
      return function () {
        if (mirrors.get(key) === m) {
          mirrors.delete(key);
        }
      };
    }

    return {
      start: start,
      stop: stop,
      subscribe: subscribe,
      mirror: mirror,
      kick: kick,
      overview: {
        rows: function () {
          return rows;
        },
        // Whether rows() is what the server said, or still the empty list from before its first answer.
        ready: function () {
          return overviewVersion != null;
        },
        on: function (fn) {
          overviewFns.add(fn);
          return function () {
            overviewFns.delete(fn);
          };
        },
      },
      requests: {
        // Requests that came before anyone listened go to the first listener.
        on: function (fn) {
          requestFns.add(fn);
          unheard.splice(0).forEach(function (r) {
            guarded(fn, r);
          });
          return function () {
            requestFns.delete(fn);
          };
        },
      },
    };
  }

  const others = new Map();
  const tabHub = make(CC.Servers.tab());

  // The Hub of a server, for as long as it's in CC.Servers.
  tabHub.of = function (server) {
    if (server.key === CC.Servers.TAB) {
      return tabHub;
    }
    if (!others.has(server.key)) {
      others.set(server.key, make(server));
    }
    return others.get(server.key);
  };
  tabHub.drop = function (key) {
    const hub = others.get(key);
    if (hub != null) {
      others.delete(key);
      hub.stop();
    }
  };

  return tabHub;
})();
