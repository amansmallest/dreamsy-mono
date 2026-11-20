// Web audio for the player (linked with --pre-js, like embed.js): plays the game's data/sfx (sfxr-style synth)
// and data/music (chiptune sequencer, up to 4 channels) with Web Audio. A port of engine-web render/audio.ts
// (tag engine-web-final). main.cpp forwards each new Host::audio_events() entry with the song or sound JSON
// (dreamsyAudio.event) and the volumes / pause state when they change (dreamsyAudio.state).
//
// Browsers (iOS Safari above all) only start audio inside a user gesture, so the context is created and
// resumed on the first pointer / key / touch event; sounds asked for before that are dropped and the
// current song starts on unlock. iOS: the "playback" audio session keeps music playing with the ringer
// switch on silent.
var dreamsyAudio = (function () {
  var MASTER = 0.6, LOOKAHEAD = 0.2, TICK_MS = 25;
  var LEVEL = { square: 0.5, saw: 0.45, triangle: 0.9, sine: 0.9, noise: 0.7 };
  var WAVES = { square: 1, saw: 1, triangle: 1, sine: 1, noise: 1 };
  var NOTE = /^([A-G])([#b]?)([0-8])$/;
  var SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  var GESTURES = ["pointerdown", "keydown", "touchend", "mousedown"];

  var ctx = null, duck = null, sfxBus = null, musicBus = null;
  var track = null, fading = [], wanted = null, songs = {};
  var vol = { music: 0.7, sfx: 0.9, paused: false };

  function num(v, d, lo, hi) { return typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; }
  function wave(v) { return typeof v === "string" && WAVES[v] ? v : "square"; }

  function noteFreq(t) {
    var m = NOTE.exec(t);
    if (!m) return null;
    var semis = SEMI[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + 12 * (Number(m[3]) + 1);
    return 440 * Math.pow(2, (semis - 69) / 12);
  }

  function parseSfx(text) {
    var r = JSON.parse(text);
    return {
      wave: wave(r.wave), attack: num(r.attack, 0, 0, 2), sustain: num(r.sustain, 0.1, 0, 2), decay: num(r.decay, 0.2, 0, 3),
      freq: num(r.freq, 440, 20, 8000), slide: num(r.slide, 0, -4, 4), vibrato: num(r.vibrato, 0, 0, 12),
      vibrato_speed: num(r.vibrato_speed, 6, 0, 40), duty: num(r.duty, 0.5, 0.05, 0.95), volume: num(r.volume, 0.5, 0, 1),
    };
  }

  // Flattens patterns + order into note events (start step, length in steps), sorted by start.
  function compileSong(text) {
    var r = JSON.parse(text);
    var steps = Math.max(1, Math.floor(num(r.steps, 16, 1, 256)));
    var channels = (Array.isArray(r.channels) ? r.channels : []).slice(0, 4).map(function (c) {
      var notes = typeof c.notes === "string" ? c.notes.trim().split(/\s+/) : Array.isArray(c.notes) ? c.notes : [];
      return { wave: wave(c.wave), volume: num(c.volume, 0.4, 0, 1), duty: num(c.duty, 0.5, 0.05, 0.95), notes: notes };
    });
    var patterns = Math.max(1, Math.min.apply(null, channels.map(function (c) { return Math.floor(c.notes.length / steps); }).concat([256])));
    var order = Array.isArray(r.order) && r.order.length ? r.order : Array.from({ length: patterns }, function (_, i) { return i; });
    var events = [];
    channels.forEach(function (c, ch) {
      var cur = null, step = 0;
      order.forEach(function (p) {
        for (var i = 0; i < steps; i++, step++) {
          var tok = c.notes[p * steps + i] || ".";
          if (tok === "-") { if (cur) cur.len++; continue; }
          cur = null;
          if (tok === ".") continue;
          var f = noteFreq(tok);
          if (f) { cur = { ch: ch, step: step, len: 1, freq: f }; events.push(cur); }
        }
      });
    });
    events.sort(function (a, b) { return a.step - b.step || a.ch - b.ch; });
    return { events: events, channels: channels, loop: r.loop !== false, totalSteps: order.length * steps, stepDur: 60 / num(r.bpm, 120, 40, 240) / 4 };
  }

  // ---------------------------------------------------------------- synthesis

  var pulses = {}, noise = null;
  function pulseWave(duty) {
    var key = Math.round(duty * 100) / 100;
    if (!pulses[key]) {
      var N = 64, re = new Float32Array(N), im = new Float32Array(N);
      for (var n = 1; n < N; n++) {
        var a = (2 / (n * Math.PI)) * Math.sin(Math.PI * n * key);
        re[n] = a * Math.cos(Math.PI * n * key);
        im[n] = a * Math.sin(Math.PI * n * key);
      }
      pulses[key] = ctx.createPeriodicWave(re, im);
    }
    return pulses[key];
  }
  function noiseBuffer() {
    if (!noise) {
      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      var d = noise.getChannelData(0), seed = 22222;
      for (var i = 0; i < d.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; d[i] = seed / 0x3fffffff - 1; }
    }
    return noise;
  }
  // An oscillator-like source whose `freq` sets the pitch (noise: the low-pass cutoff).
  function source(w, duty) {
    if (w === "noise") {
      var src = ctx.createBufferSource();
      src.buffer = noiseBuffer();
      src.loop = true;
      var lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.Q.value = 0.7;
      src.connect(lp);
      return { node: lp, freq: lp.frequency, start: function (t) { src.start(t, Math.random() * 0.5); }, stop: function (t) { src.stop(t); } };
    }
    var osc = ctx.createOscillator();
    if (w === "square") osc.setPeriodicWave(pulseWave(duty));
    else osc.type = w === "saw" ? "sawtooth" : w;
    return { node: osc, freq: osc.frequency, start: function (t) { osc.start(t); }, stop: function (t) { osc.stop(t); } };
  }

  function playSfx(s, t0, volume, pitch) {
    var dur = s.attack + s.sustain + s.decay;
    if (dur <= 0) return;
    var v = s.volume * volume * LEVEL[s.wave];
    var env = ctx.createGain();
    env.gain.setValueAtTime(0, t0);
    if (s.attack > 0) env.gain.linearRampToValueAtTime(v, t0 + s.attack);
    else env.gain.setValueAtTime(v, t0);
    env.gain.setValueAtTime(v, t0 + s.attack + s.sustain);
    env.gain.linearRampToValueAtTime(0, t0 + dur);
    env.connect(sfxBus);
    var src = source(s.wave, s.duty);
    src.node.connect(env);
    var f0 = Math.min(20000, Math.max(10, s.freq * pitch));
    src.freq.setValueAtTime(f0, t0);
    if (s.slide !== 0) src.freq.exponentialRampToValueAtTime(Math.min(20000, Math.max(10, f0 * Math.pow(2, s.slide))), t0 + dur);
    if (s.vibrato > 0 && s.vibrato_speed > 0) {
      var lfo = ctx.createOscillator(), depth = ctx.createGain();
      lfo.frequency.value = s.vibrato_speed;
      depth.gain.value = f0 * (Math.pow(2, s.vibrato / 12) - 1);
      lfo.connect(depth).connect(src.freq);
      lfo.start(t0);
      lfo.stop(t0 + dur + 0.05);
    }
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  function scheduleNote(dest, c, ev, t, dur) {
    var v = c.volume * LEVEL[c.wave] * 0.6, rel = Math.min(0.04, dur * 0.3);
    var env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(v, t + 0.004);
    env.gain.setValueAtTime(v, t + Math.max(0.005, dur - rel));
    env.gain.linearRampToValueAtTime(0, t + dur);
    env.connect(dest);
    var src = source(c.wave, c.duty);
    src.freq.setValueAtTime(c.wave === "noise" ? Math.min(18000, ev.freq * 4) : ev.freq, t);
    src.node.connect(env);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  // Every note that starts in [from, to) of a song that began at `origin` (looping if set).
  function scheduleRange(tr, from, to) {
    var s = tr.song, len = s.totalSteps * s.stepDur;
    if (len <= 0) return;
    for (var k = Math.max(0, Math.floor((from - tr.origin) / len)); ; k++) {
      var base = tr.origin + k * len;
      if (base >= to || (!s.loop && k > 0)) break;
      for (var i = 0; i < s.events.length; i++) {
        var ev = s.events[i], t = base + ev.step * s.stepDur;
        if (t < from) continue;
        if (t >= to) break;
        scheduleNote(tr.gain, s.channels[ev.ch], ev, t, ev.len * s.stepDur);
      }
    }
  }

  // ---------------------------------------------------------------- live engine

  function running() { return !!ctx && ctx.state === "running"; }

  function applyVolumes() {
    if (!ctx) return;
    var now = ctx.currentTime;
    sfxBus.gain.setTargetAtTime(vol.sfx * MASTER, now, 0.02);
    musicBus.gain.setTargetAtTime(vol.music * MASTER, now, 0.05);
    duck.gain.setTargetAtTime(vol.paused ? 0.25 : 1, now, 0.08);  // the pause menu ducks the music
  }

  function unlock() {
    try {
      if (!ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch (e) {}
        ctx = new AC();
        duck = ctx.createGain();
        duck.connect(ctx.destination);
        sfxBus = ctx.createGain();
        musicBus = ctx.createGain();
        sfxBus.connect(duck);
        musicBus.connect(duck);
        applyVolumes();
        setInterval(pump, TICK_MS);
      }
      if (ctx.state !== "running") {
        ctx.resume();
        var s = ctx.createBufferSource();  // a silent blip completes the iOS unlock
        s.buffer = ctx.createBuffer(1, 1, 22050);
        s.connect(ctx.destination);
        s.start(0);
      }
    } catch (e) {
      console.warn("[dreamsy] audio unavailable", e);
    }
  }
  GESTURES.forEach(function (g) { window.addEventListener(g, unlock, { capture: true }); });
  // Background tab / locked phone: silence; back: carry on.
  document.addEventListener("visibilitychange", function () {
    if (!ctx) return;
    if (document.hidden) ctx.suspend(); else ctx.resume();
  });

  function stopTrack(fade) {
    var t = track;
    track = null;
    if (!t || !ctx) return;
    var now = ctx.currentTime, f = Math.max(0.03, fade);
    t.gain.gain.cancelScheduledValues(now);
    t.gain.gain.setValueAtTime(t.gain.gain.value, now);
    t.gain.gain.linearRampToValueAtTime(0, now + f);
    t.endAt = now + f;
    fading.push(t);
  }

  function startTrack(id, fade) {
    var song = songs[id];
    if (!song) { wanted = null; return; }
    stopTrack(Math.max(fade, 0.05));
    var now = ctx.currentTime, gain = ctx.createGain();
    gain.gain.setValueAtTime(fade > 0 ? 0 : 1, now);
    if (fade > 0) gain.gain.linearRampToValueAtTime(1, now + fade);
    gain.connect(musicBus);
    var origin = now + 0.05;
    track = { id: id, song: song, gain: gain, origin: origin, scheduledTo: origin, endAt: song.loop ? null : origin + song.totalSteps * song.stepDur };
  }

  // Lookahead scheduler; runs from a timer so music keeps going between frames.
  function pump() {
    if (!running()) return;
    if (wanted && (!track || track.id !== wanted.id)) startTrack(wanted.id, wanted.fade);
    var now = ctx.currentTime;
    [track].concat(fading).forEach(function (t) {
      if (!t) return;
      var until = Math.min(now + LOOKAHEAD, t.endAt === null ? Infinity : t.endAt);
      if (until > t.scheduledTo) { scheduleRange(t, t.scheduledTo, until); t.scheduledTo = until; }
    });
    fading = fading.filter(function (t) {
      if (t.endAt !== null && now > t.endAt + 0.1) { t.gain.disconnect(); return false; }
      return true;
    });
    if (track && track.endAt !== null && now > track.endAt + 0.1) { track.gain.disconnect(); track = null; wanted = null; }
  }

  return {
    // kind "sfx" | "music" | "music_stop"; json: the sound or song file (music: only the first time per id).
    event: function (kind, id, json, volume, pitch, fade) {
      try {
        if (kind === "sfx") {
          if (!running() || vol.paused || !json) return;
          playSfx(parseSfx(json), ctx.currentTime + 0.005, volume, pitch);
        } else if (kind === "music") {
          if (json && !songs[id]) songs[id] = compileSong(json);
          wanted = { id: id, fade: fade };
          pump();
        } else {
          wanted = null;
          stopTrack(fade);
        }
      } catch (e) {
        console.warn("[dreamsy] audio: " + kind + " " + id + ": " + e);
      }
    },
    state: function (music, sfx, paused) {
      vol.music = music;
      vol.sfx = sfx;
      vol.paused = !!paused;
      applyVolumes();
    },
  };
})();
