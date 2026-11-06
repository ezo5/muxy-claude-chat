// Notification sounds on settings key `notify`: {attention, finished, volume, focused, banner}, where attention and finished are a sound
// name or null for off. The server plays a system sound if it can reach the speakers; otherwise a tone from this page.
CC.Sounds = (function () {
  const DEFAULTS = { attention: "Glass", finished: "Tink", volume: 0.6, focused: false, banner: false };
  const MAC_SOUNDS = ["Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink"];
  const CALL_TIMEOUT_MS = 5000;
  const NOTE_GAP_S = 0.16;
  const CLOSE_AFTER_MS = 1200;

  function settings() {
    return Object.assign({}, DEFAULTS, CC.settings.get("notify") || {});
  }

  function save(patch) {
    return CC.settings.set("notify", Object.assign({}, settings(), patch));
  }

  // Named sounds exist only on a Mac. Elsewhere a setting is just on or off, and any name plays the tone.
  function names() {
    return /mac/i.test(navigator.platform || "") ? MAC_SOUNDS.slice() : [];
  }

  function chime(kind, volume) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx == null) {
      console.warn("no WebAudio here, so no notification tone");
      return;
    }
    const ctx = new Ctx();
    const notes = kind === "attention" ? [880, 660] : [660, 990];
    notes.forEach(function (hz, i) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = ctx.currentTime + i * NOTE_GAP_S;
      osc.frequency.value = hz;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.001, 0.35 * volume), t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.32);
    });
    setTimeout(function () {
      ctx.close();
    }, CLOSE_AFTER_MS);
  }

  async function play(kind) {
    const s = settings();
    const name = s[kind];
    if (!name) {
      return;
    }
    let played = false;
    try {
      const res = await CC.Servers.focused().host.call("sound", { name: name, volume: s.volume }, { timeoutMs: CALL_TIMEOUT_MS });
      played = res != null && Boolean(res.played);
    } catch (e) {
      console.warn("sound failed:", e && e.message);
    }
    if (played) {
      return;
    }
    try {
      chime(kind, s.volume);
    } catch (e) {
      console.warn("tone failed:", e && e.message);
    }
  }

  return { DEFAULTS: DEFAULTS, settings: settings, save: save, names: names, play: play, preview: play, chime: chime };
})();
