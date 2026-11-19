/**
 * app.js — Phase 13 Tesla parked media application.
 *
 * Classic script (no bundler). Uses:
 *   core.js          pure helpers
 *   mp4-demux.js     audited ISO-BMFF demuxer (build exposes window.demuxMp4)
 *   decoder-worker.js  Phase 11/12 decode/present worker + seek
 *
 * Two playback backends:
 *   webcodecs  bundled H.264 ladder (360p/540p/720p), worker + OffscreenCanvas
 *   native     arbitrary authorized media URL through <video>
 */
(function () {
  "use strict";

  var core = window.TeslaMediaCore;
  var VERSION = core.APP_VERSION;
  var $ = function (id) { return document.getElementById(id); };
  var now = function () { return performance.now(); };
  var USER_KEY = "tesla.media.user.v1";
  var SETTINGS_KEY = "tesla.media.settings.v1";

  var CAPS = detectCaps();

  var state = {
    parked: false,
    view: "library",
    library: [],
    builtin: [],
    user: [],
    current: null,
    item: null,
    variant: null,
    backend: null,
    quality: "720p",
    defaultQuality: "720p",
    loop: true,
    adaptive: true,
    audioSync: false,
    showStats: false,
    volume: 0.8,
    muted: false,
    playing: false,
    paused: false,
    loading: false,
    error: null,
    positionMs: 0,
    durationMs: 0,
    loopCount: 0,
    lead: 300,
    seeking: false,
    engine: null,
    run: null,
    lastRun: null,
    history: [],
    liveStats: null,
    chart: [],
    errors: [],
    logs: [],
    memory: null,
    validation: null,
    toastTimer: 0,
    uiTimer: 0,
    lastPressureAt: 0,
    lastQueueDrops: 0,
    lastRebuffers: 0,
    lastSeeks: 0,
    audio: {
      ctx: null, buffer: null, src: null, gain: null,
      startCtx: 0, started: false, latency: 0, warmupUntil: 0,
      lastOut: null, resyncs: 0, samples: 0, skipped: 0,
      scheduled: [], audible: [], timeline: [],
      stateEvents: [], visibilityEvents: []
    }
  };

  var els = {};

  /* ---------------------------------------------------------------- boot */

  function boot() {
    cacheDom();
    loadSettings();
    loadUserMedia();
    bindEvents();
    renderUserList();
    updateSettingsControls();
    applyVolume();
    renderLibrary();
    updateNowPlaying();
    updateControls();
    renderMetrics();
    loadCatalog();
    state.uiTimer = setInterval(uiTick, 200);
    setInterval(sampleMemory, 2000);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", closeAudio);
  }

  function cacheDom() {
    els = {
      gate: $("gate"), parkConfirm: $("parkConfirm"), gateEnter: $("gateEnter"),
      libraryGrid: $("libraryGrid"), fileCount: $("fileCount"),
      stage: $("stage"), host: $("stageCanvasHost"), stageStatus: $("stageStatus"),
      stageBackend: $("stageBackend"), bigPlay: $("bigPlay"), loading: $("loading"),
      errorPanel: $("errorPanel"), errorTitle: $("errorTitle"), errorText: $("errorText"),
      errorRetry: $("errorRetry"), errorLibrary: $("errorLibrary"),
      emptyStage: $("emptyStage"), hud: $("hud"), hudFps: $("hudFps"),
      hudDrops: $("hudDrops"), hudDrift: $("hudDrift"), hudQueue: $("hudQueue"), hudLead: $("hudLead"),
      nowTitle: $("nowTitle"), nowSub: $("nowSub"), qualitySelect: $("qualitySelect"),
      loopBtn: $("loopBtn"), statsBtn: $("statsBtn"), seekBar: $("seekBar"),
      timeNow: $("timeNow"), timeTotal: $("timeTotal"), playBtn: $("playBtn"),
      stopBtn: $("stopBtn"), prevBtn: $("prevBtn"), nextBtn: $("nextBtn"),
      muteBtn: $("muteBtn"), volumeBar: $("volumeBar"), fullBtn: $("fullBtn"),
      backendChip: $("backendChip"), toast: $("toast"),
      navLibrary: $("navLibrary"), navDiagnostics: $("navDiagnostics"), navSettings: $("navSettings"),
      viewLibrary: $("view-library"), viewDiagnostics: $("view-diagnostics"), viewSettings: $("view-settings"),
      diagState: $("diagState"), diagCards: $("diagCards"), chart: $("chart"), chartNote: $("chartNote"),
      mFps: $("mFps"), mFpsSub: $("mFpsSub"), mDrops: $("mDrops"), mDropsSub: $("mDropsSub"),
      mRebuf: $("mRebuf"), mRebufSub: $("mRebufSub"), mDrift: $("mDrift"), mDriftSub: $("mDriftSub"),
      mDQ: $("mDQ"), mDQSub: $("mDQSub"), mFQ: $("mFQ"), mFQSub: $("mFQSub"),
      mLead: $("mLead"), mLeadSub: $("mLeadSub"), mErrors: $("mErrors"), mErrorsSub: $("mErrorsSub"),
      runReason: $("runReason"), diagTable: $("diagTable"), historyBody: $("historyBody"),
      historyNote: $("historyNote"), jsonOut: $("jsonOut"), shortOut: $("shortOut"),
      copyBtn: $("copyBtn"), downloadBtn: $("downloadBtn"), selectBtn: $("selectBtn"),
      clearHistoryBtn: $("clearHistoryBtn"), validationStatus: $("validationStatus"),
      stopTestBtn: $("stopTestBtn"), settingsQuality: $("settingsQuality"),
      settingsLoop: $("settingsLoop"), settingsAdaptive: $("settingsAdaptive"),
      settingsAudio: $("settingsAudio"), settingsVersion: $("settingsVersion"),
      urlTitle: $("urlTitle"), urlValue: $("urlValue"), urlError: $("urlError"),
      addMediaBtn: $("addMediaBtn"), userMediaList: $("userMediaList"),
      resetSettings: $("resetSettings"), addUrlBtn: $("addUrlBtn"),
      aboutVersion: $("aboutVersion")
    };
    els.settingsVersion.textContent = VERSION;
    els.aboutVersion.textContent = VERSION;
    els.volumeBar.value = String(Math.round(state.volume * 100));
  }

  function detectCaps() {
    var v = document.createElement("video");
    var can = function (t) { try { return !!v.canPlayType(t); } catch (e) { return false; } };
    return {
      webcodecs: typeof VideoDecoder !== "undefined" && typeof EncodedVideoChunk !== "undefined" && typeof VideoFrame !== "undefined",
      offscreen: typeof OffscreenCanvas !== "undefined",
      native: typeof v.canPlayType === "function",
      h264: can('video/mp4; codecs="avc1.42E01E"'),
      vp8: can('video/webm; codecs="vp8"'),
      vp9: can('video/webm; codecs="vp9"'),
      mse: typeof MediaSource !== "undefined",
      webrtc: typeof RTCPeerConnection !== "undefined",
      wasm: typeof WebAssembly !== "undefined",
      audio: typeof AudioContext !== "undefined",
      security: window.isSecureContext === true,
      chromium: (function () { var m = /(?:HeadlessChrome|Chromium|Chrome)\/(\d+)/.exec(navigator.userAgent || ""); return m ? parseInt(m[1], 10) : null; })()
    };
  }

  /* ------------------------------------------------------------ settings */

  function loadSettings() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      var s = JSON.parse(raw);
      if (core.QUALITIES.indexOf(s.defaultQuality) >= 0) state.defaultQuality = s.defaultQuality;
      if (typeof s.loop === "boolean") state.loop = s.loop;
      if (typeof s.adaptive === "boolean") state.adaptive = s.adaptive;
      if (typeof s.audioSync === "boolean") state.audioSync = s.audioSync;
      if (typeof s.volume === "number") state.volume = core.clamp(s.volume, 0, 1);
      if (typeof s.muted === "boolean") state.muted = s.muted;
    } catch (e) { /* ignore corrupt local settings */ }
  }
  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        defaultQuality: state.defaultQuality,
        loop: state.loop,
        adaptive: state.adaptive,
        audioSync: state.audioSync,
        volume: state.volume,
        muted: state.muted
      }));
    } catch (e) { /* private mode */ }
  }
  function updateSettingsControls() {
    els.settingsQuality.value = state.defaultQuality;
    els.settingsLoop.checked = state.loop;
    els.settingsAdaptive.checked = state.adaptive;
    els.settingsAudio.checked = state.audioSync;
    els.loopBtn.setAttribute("aria-pressed", state.loop ? "true" : "false");
    els.statsBtn.setAttribute("aria-pressed", state.showStats ? "true" : "false");
    els.hud.hidden = !state.showStats;
    els.volumeBar.value = String(Math.round((state.muted ? 0 : state.volume) * 100));
  }

  function loadUserMedia() {
    try {
      var raw = localStorage.getItem(USER_KEY);
      if (!raw) return;
      var list = JSON.parse(raw);
      if (Array.isArray(list)) state.user = list.filter(function (x) { return x && x.url && x.title; }).slice(0, 50);
    } catch (e) { state.user = []; }
  }
  function saveUserMedia() {
    try { localStorage.setItem(USER_KEY, JSON.stringify(state.user)); }
    catch (e) { toast("Could not save added URLs in this browser."); }
  }

  /* -------------------------------------------------------------- catalog */

  function builtinCatalog() {
    return {
      items: [
        {
          id: "demo-loop", title: "Diagnostic Loop", subtitle: "Synthetic 6 s H.264 ladder · WebCodecs",
          description: "Locally generated 1280×720 H.264 clip with three quality rungs.",
          kind: "demo", backend: "webcodecs", container: "mp4", loop: true, audio: "none",
          duration_ms: 6009.5, defaultQuality: "720p", accent: "blue",
          variants: [
            { quality: "360p", label: "360p", url: "media/360p-h264.mp4", width: 640, height: 360, bytes: 448495 },
            { quality: "540p", label: "540p", url: "media/540p-h264.mp4", width: 960, height: 540, bytes: 1648976 },
            { quality: "720p", label: "720p", url: "media/720p-h264.mp4", width: 1280, height: 720, bytes: 2654303 }
          ]
        },
        {
          id: "demo-vp8", title: "VP8 Comparison", subtitle: "Native <video> backend · 720p WebM",
          description: "The same synthetic source as VP8 WebM. Exercises the automatic native backend.",
          kind: "demo", backend: "native", container: "webm", loop: true, audio: "native",
          duration_ms: 6009.5, defaultQuality: "720p", accent: "violet",
          url: "media/720p-vp8.webm", quality: "720p", width: 1280, height: 720
        }
      ]
    };
  }

  async function loadCatalog() {
    var data = null;
    try {
      var res = await fetch("library.json", { cache: "no-store" });
      if (res.ok) data = await res.json();
    } catch (e) { /* fall back */ }
    var items = data && Array.isArray(data.items) ? data.items : builtinCatalog().items;
    state.builtin = items.filter(validItem);
    rebuildLibrary();
    window.__appReady = true;
  }

  function validItem(item) {
    if (!item || !item.id || !item.title) return false;
    if (item.variants && item.variants.length) return item.variants.every(function (v) { return v.url && core.QUALITIES.indexOf(v.quality) >= 0; });
    return !!item.url;
  }

  function rebuildLibrary() {
    state.library = state.builtin.concat(state.user.map(userToItem));
    renderLibrary();
    if (state.current) {
      var still = state.library.filter(function (i) { return i.id === state.current.id; })[0];
      if (!still) { state.current = null; updateNowPlaying(); }
    }
  }

  function userToItem(u) {
    return {
      id: u.id, title: u.title, subtitle: u.url.replace(/^https?:\/\//, "").slice(0, 70),
      description: "Added by the user", kind: "user", backend: "native", loop: false,
      audio: "native", url: u.url, quality: "Auto", defaultQuality: "Auto",
      accent: "green", user: true
    };
  }

  function renderLibrary() {
    var g = els.libraryGrid;
    g.replaceChildren();
    state.library.forEach(function (item) {
      var card = document.createElement("article");
      card.className = "media-card" + (state.item && state.item.id === item.id ? " active" : "");
      card.dataset.id = item.id;
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", "Play " + item.title);

      var poster = document.createElement("div");
      poster.className = "poster " + (item.accent || "blue");
      poster.innerHTML = '<svg><use href="#i-film"/></svg>';

      var body = document.createElement("div");
      var h3 = document.createElement("h3"); h3.textContent = item.title;
      var p = document.createElement("p"); p.textContent = item.subtitle || "";
      var chips = document.createElement("div"); chips.className = "card-chips";
      var b = document.createElement("span"); b.className = "mini-chip"; b.textContent = item.backend === "webcodecs" ? "WEBCODECS" : "NATIVE";
      chips.appendChild(b);
      if (item.variants) {
        var q = document.createElement("span"); q.className = "mini-chip"; q.textContent = item.variants.length + " QUALITIES"; chips.appendChild(q);
      }
      if (item.audio === "none") {
        var a = document.createElement("span"); a.className = "mini-chip"; a.textContent = "SILENT"; chips.appendChild(a);
      }
      body.appendChild(h3); body.appendChild(p); body.appendChild(chips);

      var btn = document.createElement("button");
      btn.className = "icon-btn"; btn.type = "button";
      btn.setAttribute("aria-label", "Play " + item.title);
      btn.innerHTML = '<svg><use href="#i-play"/></svg>';

      card.appendChild(poster); card.appendChild(body); card.appendChild(btn);
      var activate = function (e) { if (e) e.preventDefault(); selectItem(item); };
      card.addEventListener("click", activate);
      card.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") activate(e); });
      btn.addEventListener("click", function (e) { e.stopPropagation(); selectItem(item); });
      g.appendChild(card);
    });
    els.fileCount.textContent = state.library.length + " title" + (state.library.length === 1 ? "" : "s");
    if (state.item && state.item.variants) populateQuality();
  }

  /* --------------------------------------------------------------- gate */

  function bindEvents() {
    els.parkConfirm.addEventListener("change", function () { els.gateEnter.disabled = !els.parkConfirm.checked; });
    els.gateEnter.addEventListener("click", enterApp);
    els.navLibrary.addEventListener("click", function () { showView("library"); });
    els.navDiagnostics.addEventListener("click", function () { showView("diagnostics"); });
    els.navSettings.addEventListener("click", function () { showView("settings"); });
    els.playBtn.addEventListener("click", togglePlay);
    els.bigPlay.addEventListener("click", togglePlay);
    els.stopBtn.addEventListener("click", function () { stopPlayback("stop"); });
    els.prevBtn.addEventListener("click", function () { stepItem(-1); });
    els.nextBtn.addEventListener("click", function () { stepItem(1); });
    els.seekBar.addEventListener("input", onSeekInput);
    els.seekBar.addEventListener("change", onSeekCommit);
    els.volumeBar.addEventListener("input", function () { setVolume(Number(els.volumeBar.value) / 100); });
    els.muteBtn.addEventListener("click", toggleMute);
    els.fullBtn.addEventListener("click", toggleFullscreen);
    els.loopBtn.addEventListener("click", toggleLoop);
    els.statsBtn.addEventListener("click", function () {
      state.showStats = !state.showStats;
      els.hud.hidden = !state.showStats;
      els.statsBtn.setAttribute("aria-pressed", state.showStats ? "true" : "false");
    });
    els.qualitySelect.addEventListener("change", function () { setQuality(els.qualitySelect.value); });
    els.errorRetry.addEventListener("click", retryCurrent);
    els.errorLibrary.addEventListener("click", function () { clearError(); showView("library"); });
    els.addUrlBtn.addEventListener("click", function () { showView("settings"); els.urlTitle.focus(); });
    els.addMediaBtn.addEventListener("click", addUserMediaFromForm);
    els.settingsQuality.addEventListener("change", function () {
      state.defaultQuality = els.settingsQuality.value; saveSettings();
      if (state.item && state.item.variants) setQuality(state.defaultQuality);
    });
    els.settingsLoop.addEventListener("change", function () { state.loop = els.settingsLoop.checked; applyLoop(); saveSettings(); });
    els.settingsAdaptive.addEventListener("change", function () { state.adaptive = els.settingsAdaptive.checked; saveSettings(); });
    els.settingsAudio.addEventListener("change", function () {
      state.audioSync = els.settingsAudio.checked; saveSettings();
      if (state.audioSync) { prepareAudio().then(function () { if (state.playing) startTone(engineMediaSec()); }); }
      else stopTone();
    });
    els.resetSettings.addEventListener("click", resetLocal);
    els.clearHistoryBtn.addEventListener("click", function () { state.history = []; renderHistory(); renderDiagnostics(); toast("History cleared."); });
    els.copyBtn.addEventListener("click", copyJson);
    els.downloadBtn.addEventListener("click", downloadJson);
    els.selectBtn.addEventListener("click", function () { els.jsonOut.focus(); els.jsonOut.select(); });
    Array.prototype.forEach.call(document.querySelectorAll(".test-run"), function (btn) {
      btn.addEventListener("click", function () { startValidation(Number(btn.dataset.seconds)); });
    });
    els.stopTestBtn.addEventListener("click", function () { stopPlayback("stop"); });
    document.addEventListener("keydown", onKey);
    window.addEventListener("error", function (e) { pushError(String(e.message || e.error || "script error")); });
    window.addEventListener("unhandledrejection", function (e) { pushError(String((e.reason && e.reason.message) || e.reason || "promise rejection")); });
  }

  function enterApp() {
    if (!els.parkConfirm.checked) return;
    state.parked = true;
    els.gate.classList.add("hidden");
    toast("Parked mode confirmed. Choose a title.");
    updateControls();
  }

  /* ------------------------------------------------------------- playback */

  function selectItem(item, quality) {
    if (!state.parked) { els.gate.classList.remove("hidden"); return; }
    loadItem(item, quality || state.defaultQuality, 0, true);
  }

  async function loadItem(item, quality, startAtMs, autoplay, opts) {
    if (!state.parked) { els.gate.classList.remove("hidden"); return; }
    opts = opts || {};
    await destroyEngine("switch");
    clearError();
    state.item = item;
    state.variant = core.chooseVariant(item, quality);
    state.quality = state.variant ? state.variant.quality : (item.quality || "Auto");
    state.backend = core.chooseBackend(item, CAPS);
    if (state.backend === "webcodecs" && !CAPS.offscreen) state.backend = "native";
    state.positionMs = core.clamp(startAtMs || 0, 0, item.duration_ms || 0);
    state.durationMs = item.duration_ms || 0;
    state.loopCount = 0;
    state.liveStats = null;
    state.chart = [];
    state.lead = 300;
    state.lastQueueDrops = 0;
    state.lastRebuffers = 0;
    state.lastSeeks = 0;
    state.lastPressureAt = now();
    state.run = newRun(item, opts);
    resetAudioForRun();
    state.current = item;
    state.playing = false;
    state.paused = false;
    updateNowPlaying();
    populateQuality();
    renderLibrary();
    showLoading(true);
    setStageStatus("LOADING", "");
    els.stage.classList.remove("idle");
    els.emptyStage.hidden = true;

    try {
      if (state.backend === "webcodecs") {
        state.engine = new WebCodecsEngine(engineCallbacks());
        await state.engine.load(item, state.variant, {
          leadMs: state.lead,
          loopForever: state.loop,
          runMs: opts.runMs || 0,
          validation: !!opts.validation,
          startAtMs: state.positionMs,
          autoplay: autoplay !== false
        });
        els.stageBackend.textContent = "WEBCODECS · " + (state.variant ? state.variant.width + "×" + state.variant.height : "");
      } else if (state.backend === "native") {
        state.engine = new NativeEngine(engineCallbacks());
        await state.engine.load(item, {
          startAtMs: state.positionMs,
          autoplay: autoplay !== false,
          loop: state.loop,
          volume: state.muted ? 0 : state.volume
        });
        els.stageBackend.textContent = "NATIVE · " + (state.engine.width || item.width || "?") + "×" + (state.engine.height || item.height || "?");
      } else {
        throw new Error("No supported playback method for this item.");
      }
      state.playing = autoplay !== false && !state.engine.autoplayBlocked;
      state.paused = !state.playing;
      if (!state.playing) {
        hideLoading();
        setStageStatus("PAUSED", "buffer");
        toast("Press Play to start this media.");
      } else {
        setStageStatus("PLAYING", "live");
      }
      updateControls();
    } catch (e) {
      showPlaybackError("Could not start playback", friendlyError(e), true);
      if (state.run) state.run.errors.push(String((e && e.message) || e));
    }
  }

  function newRun(item, opts) {
    return {
      id: "run-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36),
      started_at: new Date().toISOString(),
      item_id: item.id,
      title: item.title,
      backend: state.backend,
      quality: state.quality,
      width: state.variant ? state.variant.width : (item.width || null),
      height: state.variant ? state.variant.height : (item.height || null),
      validation_seconds: opts && opts.runMs ? Math.round(opts.runMs / 1000) : null,
      is_validation: !!(opts && opts.runMs),
      settings: {
        lead_ms: state.lead, adaptive: state.adaptive, loop: state.loop,
        audio_sync: state.audioSync, volume: state.volume
      },
      events: [], errors: [], stats: null, audio: null,
      finalized: false, ended_at: null, reason: null
    };
  }

  function freshAudio() {
    return {
      ctx: null, buffer: null, src: null, gain: null,
      startCtx: 0, started: false, latency: 0, warmupUntil: 0,
      lastOut: null, resyncs: 0, samples: 0, skipped: 0,
      scheduled: [], audible: [], timeline: [],
      stateEvents: [], visibilityEvents: []
    };
  }
  function resetAudioForRun() {
    var a = state.audio;
    stopTone();
    a.started = false; a.lastOut = null; a.warmupUntil = 0;
    a.resyncs = 0; a.samples = 0; a.skipped = 0;
    a.scheduled = []; a.audible = []; a.timeline = [];
    a.stateEvents = []; a.visibilityEvents = [];
  }
  function closeAudio() {
    stopTone();
    if (state.audio.ctx) {
      try { state.audio.ctx.close(); } catch (e) {}
      state.audio.ctx = null;
      state.audio.buffer = null;
      state.audio.gain = null;
    }
  }

  function engineCallbacks() {
    return {
      onReady: function (info) {
        if (state.run) state.run.codec = info.codec || null;
      },
      onFirstFrame: function (info) {
        hideLoading();
        clearError();
        state.playing = true;
        state.paused = false;
        setStageStatus("PLAYING", "live");
        updateControls();
        if (state.audioSync && state.backend === "webcodecs") {
          prepareAudio()
            .then(function () { return state.engine && state.engine.requestTime ? state.engine.requestTime() : engineMediaSec(); })
            .then(function (sec) { startTone(sec == null ? engineMediaSec() : sec); })
            .catch(function (e) { pushError("Audio: " + e.message); });
        }
      },
      onStats: onEngineStats,
      onDone: onEngineDone,
      onError: function (message) {
        pushError(message);
        if (state.run) state.run.errors.push(message);
        toast("Decoder error: " + message);
        setStageStatus("RECOVERING", "buffer");
      },
      onLog: function (message) { state.logs.push({ t: Date.now(), message: message }); if (state.logs.length > 300) state.logs.shift(); },
      onSeeked: function (info) {
        state.lastQueueDrops = state.liveStats ? (state.liveStats.queue_drops || 0) : 0;
        state.lastRebuffers = state.liveStats ? (state.liveStats.rebuffers || 0) : 0;
        state.lastSeeks = state.liveStats ? (state.liveStats.seeks || 0) : 0;
        state.lastPressureAt = now();
        if (state.audioSync && state.playing) startTone(info.media_ms / 1000);
        if (state.run) state.run.events.push({ type: "seek", t_ms: Math.round(now()), media_ms: info.media_ms, loop: info.loop });
      }
    };
  }

  function onEngineStats(m) {
    state.liveStats = m;
    state.positionMs = m.position_ms != null ? m.position_ms : (m.media_time_ms % (state.durationMs || 1));
    if (m.duration_ms) state.durationMs = m.duration_ms;
    state.loopCount = m.loop || 0;
    if (m.lead_ms) state.lead = m.lead_ms;
    if (state.run) {
      state.run.stats = mergeStats(state.run.stats, m);
      state.run.events.push({ type: "stats", t_ms: Math.round(now()), fps: m.fps, position_ms: state.positionMs, loop: state.loopCount });
      if (state.run.events.length > 120) state.run.events.splice(0, state.run.events.length - 120);
    }
    if (state.audioSync && state.playing && state.backend === "webcodecs") {
      sampleDrift((m.media_time_ms != null ? m.media_time_ms : m.position_ms) / 1000);
    }
    adaptLead(m);
    pushChart(m);
    if (state.view === "diagnostics") renderMetrics();
  }

  function onEngineDone(stats, reason) {
    state.liveStats = stats;
    state.playing = false;
    state.paused = false;
    hideLoading();
    setStageStatus(reason === "duration" ? "COMPLETE" : reason === "stop" ? "STOPPED" : "ENDED", "");
    if (state.engine) state.engine.done = true;
    stopTone();
    finalizeRun(reason, stats);
    updateControls();
    setTimeout(function () {
      if (state.engine && state.engine.done) {
        try { state.engine.destroy(); } catch (e) {}
        state.engine = null;
      }
    }, 1500);
    if (state.validation) {
      var sec = state.validation.seconds;
      state.audioSync = state.validation.audioWas;
      els.settingsAudio.checked = state.audioSync;
      state.validation = null;
      els.validationStatus.textContent = "Completed " + sec + " s run. Result is in the export panel and history.";
      els.stopTestBtn.disabled = true;
      toast("Validation complete: " + sec + " s.");
      renderDiagnostics();
      renderDiagnosticsExport();
    }
  }

  function mergeStats(prev, m) {
    var out = prev ? JSON.parse(JSON.stringify(prev)) : {};
    Object.keys(m).forEach(function (k) { out[k] = m[k]; });
    return out;
  }

  function adaptLead(m) {
    if (!state.adaptive || state.backend !== "webcodecs") return;
    if (m.seeks != null) {
      if (state.lastSeeks == null) state.lastSeeks = m.seeks;
      else if (m.seeks > state.lastSeeks) { state.lastSeeks = m.seeks; return; }
    }
    var qd = m.queue_drops || 0;
    var rb = m.rebuffers || 0;
    var qdd = Math.max(0, qd - state.lastQueueDrops);
    var rbd = Math.max(0, rb - state.lastRebuffers);
    state.lastQueueDrops = qd;
    state.lastRebuffers = rb;
    var next = state.lead;
    if (qdd > 0 || rbd > 0) {
      next = core.adaptiveLead(state.lead, { queueDropsDelta: qdd, rebuffersDelta: rbd });
      state.lastPressureAt = now();
    } else if (now() - state.lastPressureAt >= 60000) {
      next = core.adaptiveLead(state.lead, { stableMs: 60000 });
      if (next !== state.lead) state.lastPressureAt = now();
    }
    if (next !== state.lead) {
      state.lead = next;
      if (state.engine && state.engine.setLead) state.engine.setLead(next);
      if (state.run) state.run.events.push({ type: "lead", t_ms: Math.round(now()), lead_ms: next });
      toast("Decode lead adjusted to " + next + " ms.");
    }
  }

  function finalizeRun(reason, stats) {
    var run = state.run;
    if (!run || run.finalized) return;
    run.finalized = true;
    run.ended_at = new Date().toISOString();
    run.reason = reason || "stop";
    run.stats = stats || state.liveStats || run.stats || {};
    run.audio = audioSummary();
    run.settings.lead_ms = state.lead;
    state.lastRun = run;
    state.history.push(run);
    if (state.history.length > 20) state.history.shift();
    renderHistory();
    if (state.view === "diagnostics") { renderMetrics(); renderDiagnosticTable(); renderDiagnosticsExport(); }
  }

  async function destroyEngine(reason) {
    if (state.engine) {
      try { state.engine.destroy(); } catch (e) { /* ignore */ }
      state.engine = null;
    }
    stopTone();
    if (state.run && !state.run.finalized && state.liveStats) finalizeRun(reason || "switch", state.liveStats);
  }

  function stopPlayback(reason) {
    if (state.engine) {
      try { state.engine.stop(); } catch (e) { /* ignore */ }
      setTimeout(function () {
        if (state.run && !state.run.finalized) finalizeRun(reason || "stop", state.liveStats || (state.engine && state.engine.getStats && state.engine.getStats()));
        if (state.engine && state.engine.done) {
          try { state.engine.destroy(); } catch (e) {}
          state.engine = null;
        }
      }, 600);
    } else if (state.run && !state.run.finalized) {
      finalizeRun(reason || "stop", state.liveStats);
    }
    state.playing = false;
    state.paused = false;
    state.positionMs = 0;
    hideLoading();
    stopTone();
    setStageStatus("STOPPED", "");
    updateControls();
    if (state.validation) {
      var was = state.validation.audioWas;
      state.validation = null;
      state.audioSync = was;
      els.settingsAudio.checked = was;
      els.validationStatus.textContent = "Stopped. Partial result kept if any frames were presented.";
      els.stopTestBtn.disabled = true;
    }
  }

  function retryCurrent() {
    if (!state.item) { showView("library"); return; }
    var pos = state.positionMs;
    loadItem(state.item, state.quality, pos, true);
  }

  function togglePlay() {
    if (!state.item) {
      var first = state.library[0];
      if (first) selectItem(first);
      return;
    }
    if (!state.engine || state.engine.done) { loadItem(state.item, state.quality, 0, true); return; }
    if (state.playing) {
      if (state.engine) state.engine.pause();
      state.playing = false; state.paused = true;
      stopTone();
      setStageStatus("PAUSED", "buffer");
      updateControls();
    } else {
      if (state.engine) state.engine.resume();
      state.playing = true; state.paused = false;
      if (state.audioSync && state.backend === "webcodecs") {
        prepareAudio()
          .then(function () { return state.engine && state.engine.requestTime ? state.engine.requestTime() : engineMediaSec(); })
          .then(function (sec) { startTone(sec == null ? engineMediaSec() : sec); });
      }
      setStageStatus("PLAYING", "live");
      updateControls();
    }
  }

  function setQuality(q) {
    if (!state.item || !state.item.variants || q === state.quality) return;
    var pos = state.positionMs;
    var wasPlaying = state.playing;
    loadItem(state.item, q, pos, wasPlaying);
  }

  function applyLoop() {
    els.loopBtn.setAttribute("aria-pressed", state.loop ? "true" : "false");
    if (state.engine && state.engine.setLoop) state.engine.setLoop(state.loop);
    if (state.engine && state.engine.setNativeLoop) state.engine.setNativeLoop(state.loop);
  }
  function toggleLoop() {
    state.loop = !state.loop;
    saveSettings();
    applyLoop();
    toast(state.loop ? "Loop on." : "Loop off.");
  }

  function setVolume(v) {
    state.volume = core.clamp(v, 0, 1);
    state.muted = state.volume === 0;
    applyVolume();
    saveSettings();
  }
  function toggleMute() {
    state.muted = !state.muted;
    applyVolume();
    saveSettings();
  }
  function applyVolume() {
    var effective = state.muted ? 0 : state.volume;
    els.volumeBar.value = String(Math.round(effective * 100));
    els.muteBtn.innerHTML = '<svg><use href="#i-' + (effective === 0 ? "mute" : "volume") + '"/></svg>';
    if (state.engine && state.engine.setVolume) state.engine.setVolume(effective);
    if (state.audio.gain) state.audio.gain.gain.value = effective * 0.18;
  }

  function toggleFullscreen() {
    var el = document.documentElement;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(function () {});
    } else if (el.requestFullscreen) {
      el.requestFullscreen().catch(function () { toast("Fullscreen is not available in this browser."); });
    } else {
      toast("Fullscreen is not available in this browser.");
    }
  }

  function stepItem(dir) {
    if (!state.library.length) return;
    var idx = state.item ? state.library.findIndex(function (i) { return i.id === state.item.id; }) : -1;
    var next = (idx + dir + state.library.length) % state.library.length;
    selectItem(state.library[next]);
  }

  function onSeekInput() { state.seeking = true; els.timeNow.textContent = core.formatTime(Number(els.seekBar.value)); }
  function onSeekCommit() {
    var ms = Number(els.seekBar.value);
    state.seeking = false;
    state.positionMs = ms;
    if (state.engine && state.engine.seek) state.engine.seek(ms);
    if (state.run) state.run.events.push({ type: "seek_request", t_ms: Math.round(now()), media_ms: Math.round(ms) });
  }

  /* --------------------------------------------------------------- engines */

  function WebCodecsEngine(cb) {
    this.cb = cb;
    this.worker = null;
    this.canvas = null;
    this.raf = 0;
    this.pumpTimer = 0;
    this.done = false;
    this.stats = null;
    this.ready = false;
    this.pendingPlay = false;
    this.track = null;
    this.everPlayed = false;
    this.autoplayBlocked = false;
    this._starting = true;
  }
  WebCodecsEngine.prototype.load = async function (item, variant, options) {
    var self = this;
    var url = variant ? variant.url : item.url;
    if (!url) throw new Error("No media variant selected.");
    var res = await fetchWithTimeout(url, 30000);
    if (!res.ok) throw new Error("HTTP " + res.status + " loading " + url);
    var buffer = await res.arrayBuffer();
    if (!buffer.byteLength) throw new Error("The media file is empty.");
    var bytes = new Uint8Array(buffer);
    if (!window.demuxMp4) throw new Error("The MP4 demuxer did not load.");
    var track = window.demuxMp4(bytes);
    if (!track || !track.samples || !track.samples.length) throw new Error("No H.264 samples were found in this MP4.");
    this.track = track;
    var samples = track.samples.map(function (s) {
      return { offset: s.offset, size: s.size, dtsUs: s.dtsUs, ctsUs: s.ctsUs, durUs: s.durUs, isKey: s.isKey };
    });
    var config = { codec: track.codec, codedWidth: track.width, codedHeight: track.height };
    if (track.description) config.description = track.description;

    var w = variant.width || track.width;
    var h = variant.height || track.height;
    var canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.setAttribute("aria-label", item.title + " video");
    els.host.replaceChildren(canvas);
    var offscreen = canvas.transferControlToOffscreen();
    this.canvas = canvas;

    var worker = new Worker("decoder-worker.js");
    this.worker = worker;
    worker.onmessage = function (ev) { self._message(ev.data || {}); };
    worker.onerror = function (e) {
      self.cb.onError("Worker error: " + (e.message || "unknown"));
    };
    var optionsOut = {
      leadMs: options.leadMs || 300,
      maxDecodeQueue: 6,
      autoFrameQueue: true,
      lateMs: 50,
      loops: 1,
      loopForever: options.validation ? true : options.loopForever !== false,
      runMs: options.runMs || 0,
      targetFps: 30
    };
    worker.postMessage({
      type: "init",
      canvas: offscreen,
      config: config,
      samples: samples,
      bytes: buffer,
      options: optionsOut
    }, [offscreen, buffer]);
    await new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error("The decoder worker did not become ready.")); }, 12000);
      self._readyResolve = function () { clearTimeout(t); resolve(); };
      self._readyReject = function (e) { clearTimeout(t); reject(e); };
    });
    this.ready = true;
    if (options.startAtMs > 50) this.seek(options.startAtMs);
    if (options.autoplay !== false) this.play();
  };
  WebCodecsEngine.prototype._message = function (m) {
    if (m.type === "ready") {
      if (!m.worker_video_decoder) { if (this._readyReject) this._readyReject(new Error("VideoDecoder is unavailable in the worker.")); return; }
      this.info = { samples: m.samples, width: m.width, height: m.height, codec: m.codec, duration_us: m.duration_us };
      if (this.cb.onReady) this.cb.onReady(this.info);
      if (this._readyResolve) { this._readyResolve(); this._readyResolve = null; }
    } else if (m.type === "first_frame") {
      if (this.cb.onFirstFrame) this.cb.onFirstFrame(m);
    } else if (m.type === "stats") {
      var clean = Object.assign({}, m);
      delete clean.type;
      this.stats = clean;
      if (this.cb.onStats) this.cb.onStats(clean);
    } else if (m.type === "done") {
      this.done = true;
      this._stopPump();
      this.stats = m.stats;
      if (this.cb.onDone) this.cb.onDone(m.stats, m.reason);
    } else if (m.type === "error") {
      if (this.cb.onError) this.cb.onError(m.message);
    } else if (m.type === "log") {
      if (this.cb.onLog) this.cb.onLog(m.message);
    } else if (m.type === "seeked") {
      this.stats = this.stats || {};
      this.stats.position_ms = m.time_ms;
      this.stats.media_time_ms = m.media_ms;
      this.stats.loop = m.loop;
      if (this.cb.onSeeked) this.cb.onSeeked(m);
    } else if (m.type === "lead") {
      this.stats = this.stats || {};
      this.stats.lead_ms = m.lead_ms;
    } else if (m.type === "time") {
      if (this._timeResolve) {
        var resolve = this._timeResolve;
        this._timeResolve = null;
        resolve((m.media_ms || 0) / 1000);
      }
    }
  };
  WebCodecsEngine.prototype.play = function () {
    if (!this.worker || this.done) return;
    this.everPlayed = true;
    this.worker.postMessage({ type: "play" });
  };
  WebCodecsEngine.prototype.pause = function () { if (this.worker) this.worker.postMessage({ type: "pause" }); };
  WebCodecsEngine.prototype.resume = function () {
    if (!this.everPlayed) { this.play(); return; }
    if (this.worker) this.worker.postMessage({ type: "resume" });
  };
  WebCodecsEngine.prototype.seek = function (ms) { if (this.worker) this.worker.postMessage({ type: "seek", time_ms: ms }); };
  WebCodecsEngine.prototype.stop = function () { if (this.worker) this.worker.postMessage({ type: "stop" }); };
  WebCodecsEngine.prototype.setLead = function (ms) { if (this.worker) this.worker.postMessage({ type: "setLead", lead_ms: ms }); };
  WebCodecsEngine.prototype.setLoop = function (on) { if (this.worker) this.worker.postMessage({ type: "setLoop", loop_forever: !!on }); };
  WebCodecsEngine.prototype.setVolume = function () { /* video-only sample; tone gain is handled by the app */ };
  WebCodecsEngine.prototype.injectError = function () { if (this.worker) this.worker.postMessage({ type: "simulateError" }); };
  WebCodecsEngine.prototype.setSimulateCost = function (ms) { if (this.worker) this.worker.postMessage({ type: "setSimulateCost", ms: ms }); };
  WebCodecsEngine.prototype.getStats = function () { return this.stats; };
  WebCodecsEngine.prototype.getMediaSec = function () { return this.stats && this.stats.media_time_ms != null ? this.stats.media_time_ms / 1000 : 0; };
  WebCodecsEngine.prototype.requestTime = function () {
    var self = this;
    if (!this.worker) return Promise.resolve(this.getMediaSec());
    return new Promise(function (resolve) {
      self._timeResolve = resolve;
      self.worker.postMessage({ type: "time" });
      setTimeout(function () {
        if (self._timeResolve === resolve) { self._timeResolve = null; resolve(self.getMediaSec()); }
      }, 250);
    });
  };
  WebCodecsEngine.prototype._startPump = function () {
    var self = this;
    if (this.raf || this.pumpTimer) return;
    var lastFire = 0, lastRaf = 0;
    var fire = function () {
      var t = now();
      if (t - lastFire < 8) return;
      lastFire = t;
      if (self.done || !self.worker) return;
      self.worker.postMessage({ type: "tick" });
    };
    var pump = function () {
      if (self.done || !self.worker) return;
      lastRaf = now();
      fire();
      self.raf = requestAnimationFrame(pump);
    };
    this.raf = requestAnimationFrame(pump);
    // rAF is the display-aligned driver. If the compositor stops issuing
    // frames (headless/occluded), a foreground timer keeps the media clock
    // alive at ~30 Hz instead of freezing playback.
    this.pumpTimer = setInterval(function () {
      if (now() - lastRaf > 120) fire();
    }, 33);
  };
  WebCodecsEngine.prototype._stopPump = function () {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    this.pumpTimer = 0;
  };
  WebCodecsEngine.prototype.destroy = function () {
    this._stopPump();
    this.done = true;
    if (this.worker) { try { this.worker.postMessage({ type: "stop" }); } catch (e) {} try { this.worker.terminate(); } catch (e) {} }
    this.worker = null;
  };

  function NativeEngine(cb) {
    this.cb = cb;
    this.video = null;
    this.done = false;
    this.stats = null;
    this.frames = 0;
    this.firstAt = 0;
    this.lastAt = 0;
    this.intervals = [];
    this.rebuffers = 0;
    this.stalls = 0;
    this.started = false;
    this.autoplayBlocked = false;
    this.timer = 0;
    this.width = null;
    this.height = null;
  }
  NativeEngine.prototype.load = async function (item, options) {
    var self = this;
    // Same-origin media gets a fast, clear 404 instead of waiting for a media
    // element timeout. Cross-origin URLs are left to the browser (no CORS
    // requirement for native playback).
    try {
      var u = new URL(item.url, location.href);
      if (u.origin === location.origin) {
        var head = await fetch(u.href, { method: "HEAD", cache: "no-store" });
        if (head.status === 403 || head.status === 404) throw new Error("HTTP " + head.status + " loading " + item.url);
      }
    } catch (e) {
      if (/HTTP \d+/.test(String(e && e.message))) throw e;
    }
    var video = document.createElement("video");
    video.className = "stage-video";
    video.playsInline = true;
    video.preload = "auto";
    video.controls = false;
    video.loop = !!options.loop;
    video.volume = core.clamp(options.volume == null ? 0.8 : options.volume, 0, 1);
    video.setAttribute("aria-label", item.title);
    els.host.replaceChildren(video);
    this.video = video;

    video.addEventListener("loadedmetadata", function () {
      self.width = video.videoWidth; self.height = video.videoHeight;
    });
    video.addEventListener("playing", function () {
      self.started = true;
      if (self.cb.onFirstFrame) self.cb.onFirstFrame({ width: video.videoWidth, height: video.videoHeight });
    });
    video.addEventListener("waiting", function () {
      if (self.started) { self.rebuffers++; self.stalls++; }
    });
    video.addEventListener("error", function () {
      if (self.done) return;
      var msg = describeMediaError(video.error);
      if (self.cb.onError) self.cb.onError(msg);
      self.done = true;
    });
    video.addEventListener("ended", function () {
      self.done = true;
      self._stopTimer();
      if (self.cb.onDone) self.cb.onDone(self.getStats(), "end");
    });
    video.addEventListener("timeupdate", function () {
      if (self.cb.onStats) self.cb.onStats(self.getStats());
    });

    var rvfc = function (t) {
      if (self.done) return;
      self.frames++;
      if (!self.firstAt) self.firstAt = t;
      if (self.lastAt) self.intervals.push(t - self.lastAt);
      if (self.intervals.length > 240) self.intervals.shift();
      self.lastAt = t;
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(rvfc);
    };
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(rvfc);
    this.timer = setInterval(function () {
      if (!self.done && self.cb.onStats) self.cb.onStats(self.getStats());
    }, 500);

    // Attach the metadata/error listeners before assigning src: a 404 can
    // otherwise complete before the first task that would observe it.
    var ready = new Promise(function (resolve, reject) {
      var settled = false;
      var ok = function () { if (settled) return; settled = true; clearTimeout(t); resolve(); };
      var bad = function () {
        if (settled) return;
        settled = true; clearTimeout(t);
        var msg = describeMediaError(video.error);
        if (msg === "The media could not be loaded.") {
          msg = "The media did not provide metadata within 6 s. Check the URL, format and server.";
        }
        reject(new Error(msg));
      };
      var t = setTimeout(bad, 6000);
      video.addEventListener("loadedmetadata", ok, { once: true });
      video.addEventListener("error", bad, { once: true });
    });
    video.src = item.url;
    video.load();
    await ready;
    if (options.startAtMs > 0) video.currentTime = options.startAtMs / 1000;
    if (options.autoplay !== false) {
      try { await video.play(); }
      catch (e) {
        var msg = String((e && e.message) || e);
        if (/NotAllowedError|not allowed|paused to save power|user gesture/i.test(msg)) {
          this.autoplayBlocked = true;
        } else {
          throw new Error("Autoplay was blocked. Press Play. (" + msg + ")");
        }
      }
    }
  };
  NativeEngine.prototype.getStats = function () {
    var v = this.video;
    if (!v) return null;
    var wall = this.firstAt ? (now() - this.firstAt) : 0;
    var fps = wall > 0 ? (this.frames - 1) / (wall / 1000) : 0;
    var q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
    var dropped = q ? q.droppedVideoFrames : 0;
    var buffered = 0;
    try {
      if (v.buffered.length) buffered = Math.max(0, (v.buffered.end(v.buffered.length - 1) - v.currentTime) * 1000);
    } catch (e) { buffered = 0; }
    var m = {
      backend: "native",
      presented: this.frames,
      dropped: dropped,
      queue_drops: 0, late_drops: 0, burst_drops: 0, startup_drops: 0, loop_drops: 0, tick_gap_drops: 0,
      rebuffers: this.rebuffers, stalls: this.stalls,
      decoder_queue: 0, frame_queue: 0,
      fps: +fps.toFixed(2), fps_overall: +fps.toFixed(2),
      position_ms: Math.round(v.currentTime * 1000),
      media_time_ms: Math.round(v.currentTime * 1000),
      duration_ms: isFinite(v.duration) ? Math.round(v.duration * 1000) : 0,
      buffered_ahead_ms: Math.round(buffered),
      lead_ms: 0,
      loop: 0,
      width: v.videoWidth, height: v.videoHeight,
      ready_state: v.readyState, paused: v.paused,
      seekable: v.seekable && v.seekable.length ? v.seekable.end(v.seekable.length - 1) : null
    };
    this.stats = m;
    return m;
  };
  NativeEngine.prototype.play = function () { if (this.video) this.video.play().catch(function () {}); };
  NativeEngine.prototype.pause = function () { if (this.video) this.video.pause(); };
  NativeEngine.prototype.resume = function () { this.play(); };
  NativeEngine.prototype.seek = function (ms) { if (this.video) this.video.currentTime = ms / 1000; };
  NativeEngine.prototype.stop = function () {
    this.done = true;
    this._stopTimer();
    if (this.video) { try { this.video.pause(); } catch (e) {} }
    if (this.cb.onDone) this.cb.onDone(this.getStats(), "stop");
  };
  NativeEngine.prototype.setVolume = function (v) { if (this.video) this.video.volume = core.clamp(v, 0, 1); };
  NativeEngine.prototype.setLoop = function (on) { if (this.video) this.video.loop = !!on; };
  NativeEngine.prototype.setNativeLoop = function (on) { if (this.video) this.video.loop = !!on; };
  NativeEngine.prototype._stopTimer = function () { if (this.timer) clearInterval(this.timer); this.timer = 0; };
  NativeEngine.prototype.getMediaSec = function () { return this.video ? this.video.currentTime : 0; };
  NativeEngine.prototype.destroy = function () {
    this.done = true;
    this._stopTimer();
    if (this.video) { try { this.video.pause(); this.video.removeAttribute("src"); this.video.load(); } catch (e) {} }
    this.video = null;
  };

  function fetchWithTimeout(url, ms) {
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, ms);
    return fetch(url, { cache: "force-cache", signal: ctrl.signal }).finally(function () { clearTimeout(t); });
  }

  function describeMediaError(err) {
    if (!err) return "The media could not be loaded.";
    switch (err.code) {
      case 1: return "Loading was aborted.";
      case 2: return "A network error interrupted the media.";
      case 3: return "The browser could not decode this media. Try H.264 MP4 or VP8 WebM.";
      case 4: return "This media format is not supported by the browser.";
      default: return "The media could not be played.";
    }
  }
  function friendlyError(e) {
    var m = String((e && e.message) || e || "Unknown error");
    if (/HTTP 404/.test(m)) return "The media file was not found (HTTP 404). Check the URL.";
    if (/HTTP 403/.test(m)) return "The media server refused access (HTTP 403).";
    if (/AbortError|aborted/i.test(m)) return "The media request timed out.";
    if (/No H\.264|samples/i.test(m)) return "This MP4 does not contain H.264 video samples, or it is fragmented in an unsupported layout.";
    if (/VideoDecoder|decoder/i.test(m)) return "The decoder could not start. Try another quality or the native VP8 item.";
    return m;
  }

  /* ---------------------------------------------------------------- audio */

  async function prepareAudio() {
    if (!state.audioSync || !CAPS.audio || state.backend !== "webcodecs") return;
    var a = state.audio;
    if (!a.ctx) {
      a.ctx = new AudioContext();
      a.gain = a.ctx.createGain();
      a.gain.gain.value = (state.muted ? 0 : state.volume) * 0.18;
      a.gain.connect(a.ctx.destination);
      a.stateEvents.push({ t_ms: Math.round(now()), state: a.ctx.state });
      a.ctx.onstatechange = function () {
        a.stateEvents.push({ t_ms: Math.round(now()), state: a.ctx.state });
        if (a.ctx.state === "running" && a.started) { a.warmupUntil = now() + 250; a.resyncs++; startTone(engineMediaSec()); }
      };
    }
    if (a.ctx.state === "suspended") { try { await a.ctx.resume(); } catch (e) {} }
    if (!a.buffer) {
      var res = await fetch("media/sync-tone.wav", { cache: "force-cache" });
      if (!res.ok) throw new Error("sync tone HTTP " + res.status);
      var buf = await res.arrayBuffer();
      a.buffer = await a.ctx.decodeAudioData(buf);
    }
  }
  function startTone(videoSec) {
    if (!state.audioSync || state.backend !== "webcodecs" || !state.audio.buffer || !state.audio.ctx) return;
    var a = state.audio;
    try { if (a.src) { a.src.stop(); a.src.disconnect(); } } catch (e) {}
    var lat = core.clamp(a.ctx.outputLatency || a.ctx.baseLatency || 0, 0, 0.5);
    a.latency = lat;
    var dur = a.buffer.duration;
    var off = ((videoSec + lat) % dur + dur) % dur;
    var when = a.ctx.currentTime;
    var src = a.ctx.createBufferSource();
    src.buffer = a.buffer; src.loop = true; src.connect(a.gain);
    src.start(when, off);
    a.src = src; a.startCtx = when - off; a.started = true; a.lastOut = null; a.warmupUntil = now() + 200;
  }
  function stopTone() {
    var a = state.audio;
    try { if (a.src) { a.src.stop(); a.src.disconnect(); } } catch (e) {}
    a.src = null; a.started = false;
  }
  function wrapDrift(sec) {
    var d = sec % state.audio.buffer.duration;
    if (d > state.audio.buffer.duration / 2) d -= state.audio.buffer.duration;
    if (d < -state.audio.buffer.duration / 2) d += state.audio.buffer.duration;
    return d * 1000;
  }
  function sampleDrift(mediaSec) {
    var a = state.audio;
    if (!a.started || !a.ctx || !a.buffer) return;
    if (a.ctx.state !== "running" || now() < a.warmupUntil) { a.skipped++; return; }
    var schedSec = a.ctx.currentTime - a.startCtx;
    var outTs = null;
    try { outTs = a.ctx.getOutputTimestamp ? a.ctx.getOutputTimestamp() : null; } catch (e) { outTs = null; }
    var hasOut = outTs && outTs.contextTime > 0;
    if (hasOut && a.lastOut !== null && outTs.contextTime <= a.lastOut) { a.skipped++; return; }
    if (hasOut) a.lastOut = outTs.contextTime;
    var audibleSec = hasOut ? outTs.contextTime - a.startCtx : schedSec - a.latency;
    var scheduledMs = wrapDrift(schedSec - mediaSec);
    var audibleMs = wrapDrift(audibleSec - mediaSec);
    a.scheduled.push(scheduledMs); a.audible.push(audibleMs); a.samples++;
    if (a.scheduled.length > 1600) { a.scheduled.shift(); a.audible.shift(); }
    if (a.timeline.length < 400) {
      a.timeline.push({
        t_ms: Math.round(now()),
        video_ms: Math.round(mediaSec * 1000),
        scheduled_ms: +scheduledMs.toFixed(2),
        audible_ms: +audibleMs.toFixed(2),
        state: a.ctx.state
      });
    }
    if (Math.abs(audibleMs) > 250) {
      a.resyncs++;
      startTone(mediaSec);
    } else if (Math.abs(audibleMs) > 15 && state.engine && state.engine.worker) {
      state.engine.worker.postMessage({ type: "sync", drift_ms: audibleMs });
    }
  }
  function audioSummary() {
    var a = state.audio;
    var sched = statArray(a.scheduled);
    var aud = statArray(a.audible);
    return {
      mode: state.audioSync && state.backend === "webcodecs" ? "generated-tone" : "none",
      enabled: !!(state.audioSync && state.backend === "webcodecs"),
      state: a.ctx ? a.ctx.state : null,
      sample_rate: a.buffer ? a.buffer.sampleRate : null,
      output_latency_ms: a.ctx && a.ctx.outputLatency != null ? +(a.ctx.outputLatency * 1000).toFixed(2) : null,
      base_latency_ms: a.ctx && a.ctx.baseLatency != null ? +(a.ctx.baseLatency * 1000).toFixed(2) : null,
      latency_compensation_ms: +(a.latency * 1000).toFixed(2),
      samples: a.samples,
      skipped_samples: a.skipped,
      resyncs: a.resyncs,
      scheduled_mean_ms: sched.mean,
      scheduled_max_abs_ms: sched.maxAbs,
      scheduled_p95_ms: sched.p95,
      audible_mean_ms: aud.mean,
      audible_max_abs_ms: aud.maxAbs,
      audible_p95_ms: aud.p95,
      state_events: a.stateEvents.slice(0, 50),
      visibility_events: a.visibilityEvents.slice(0, 50),
      timeline: a.timeline.slice(0, 300)
    };
  }
  function statArray(arr) {
    if (!arr.length) return { mean: null, maxAbs: null, p95: null };
    var sum = 0, max = 0, abs = [];
    for (var i = 0; i < arr.length; i++) { sum += arr[i]; var v = Math.abs(arr[i]); if (v > max) max = v; abs.push(v); }
    abs.sort(function (a, b) { return a - b; });
    var p = abs[Math.min(abs.length - 1, Math.ceil(abs.length * 0.95) - 1)];
    return { mean: +(sum / arr.length).toFixed(2), maxAbs: +max.toFixed(2), p95: +p.toFixed(2) };
  }
  function engineMediaSec() {
    if (!state.engine) return 0;
    return state.engine.getMediaSec ? state.engine.getMediaSec() : 0;
  }

  /* ------------------------------------------------------------------ UI */

  function showView(name) {
    state.view = name;
    var views = { library: els.viewLibrary, diagnostics: els.viewDiagnostics, settings: els.viewSettings };
    var navs = { library: els.navLibrary, diagnostics: els.navDiagnostics, settings: els.navSettings };
    Object.keys(views).forEach(function (k) {
      views[k].classList.toggle("active", k === name);
      navs[k].classList.toggle("active", k === name);
    });
    if (name === "diagnostics") { renderDiagnostics(); renderDiagnosticsExport(); }
    if (name === "settings") renderUserList();
  }

  function updateNowPlaying() {
    if (!state.item) {
      els.nowTitle.textContent = "Nothing playing";
      els.nowSub.textContent = "Select a title from the library.";
      els.stageBackend.textContent = "—";
      els.backendChip.textContent = CAPS.webcodecs ? "WebCodecs ready" : "Native only";
      els.backendChip.className = "chip" + (CAPS.webcodecs ? " ok" : " warn");
      return;
    }
    els.nowTitle.textContent = state.item.title;
    els.nowSub.textContent = (state.item.description || state.item.subtitle || "") +
      (state.item.audio === "none" && state.audioSync ? " · diagnostic tone on" : "");
    els.backendChip.textContent = state.backend === "webcodecs" ? "WebCodecs" : "Native video";
    els.backendChip.className = "chip " + (state.backend === "webcodecs" ? "ok" : "warn");
  }

  function populateQuality() {
    var sel = els.qualitySelect;
    sel.replaceChildren();
    if (!state.item) { sel.disabled = true; return; }
    if (state.item.variants && state.item.variants.length) {
      state.item.variants.slice().sort(function (a, b) { return core.qualityRank(a.quality) - core.qualityRank(b.quality); })
        .forEach(function (v) {
          var o = document.createElement("option");
          o.value = v.quality; o.textContent = v.label + " · " + v.width + "×" + v.height;
          sel.appendChild(o);
        });
      sel.disabled = false;
      sel.value = state.quality;
    } else {
      var o = document.createElement("option");
      o.value = "Auto"; o.textContent = "Auto / native";
      sel.appendChild(o); sel.disabled = true; sel.value = "Auto";
    }
  }

  function updateControls() {
    var playing = state.playing && !state.paused;
    els.playBtn.innerHTML = '<svg><use href="#i-' + (playing ? "pause" : "play") + '"/></svg>';
    els.playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
    els.bigPlay.innerHTML = '<svg><use href="#i-' + (playing ? "pause" : "play") + '"/></svg>';
    els.stage.classList.toggle("paused", !!state.item && !playing);
    els.stage.classList.toggle("idle", !state.item);
    els.emptyStage.hidden = !!state.item;
    els.stopBtn.disabled = !state.item;
    els.fullBtn.disabled = !state.item;
    els.seekBar.disabled = !state.item;
    els.muteBtn.disabled = !state.item;
    els.volumeBar.disabled = !state.item;
    els.backendChip.textContent = state.item ? (state.backend === "webcodecs" ? "WebCodecs · " + state.quality : "Native video") : (CAPS.webcodecs ? "WebCodecs ready" : "Native only");
  }

  function setStageStatus(text, cls) {
    els.stageStatus.textContent = text;
    els.stageStatus.className = "stage-pill " + (cls || "");
  }
  function showLoading(on) {
    state.loading = !!on;
    els.loading.hidden = !on;
  }
  function hideLoading(force) { if (force !== false) { state.loading = false; els.loading.hidden = true; } }
  function clearError() {
    state.error = null;
    els.errorPanel.hidden = true;
  }
  function showPlaybackError(title, text, retry) {
    state.error = { title: title, text: text, retry: !!retry };
    state.loading = false;
    els.errorTitle.textContent = title;
    els.errorText.textContent = text;
    els.errorPanel.hidden = false;
    els.loading.hidden = true;
    setStageStatus("ERROR", "err");
    state.playing = false; state.paused = false;
    updateControls();
  }
  function pushError(message) {
    state.errors.push({ t: Date.now(), message: String(message) });
    if (state.errors.length > 100) state.errors.shift();
  }
  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("show");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () { els.toast.classList.remove("show"); }, 2600);
  }

  function uiTick() {
    if (!state.seeking && state.item) {
      var max = Math.max(1, state.durationMs || 1);
      var pos = core.clamp(state.positionMs, 0, max);
      els.seekBar.max = String(Math.round(max));
      els.seekBar.value = String(Math.round(pos));
      els.timeNow.textContent = core.formatTime(pos);
      els.timeTotal.textContent = core.formatTime(max);
    }
    if (state.liveStats) {
      var m = state.liveStats;
      els.hudFps.textContent = m.fps != null ? String(m.fps) : "—";
      els.hudDrops.textContent = String(m.dropped || 0);
      var a = audioSummary();
      els.hudDrift.textContent = a.audible_max_abs_ms == null ? (state.backend === "native" ? "native" : "—") : a.audible_max_abs_ms + " ms";
      els.hudQueue.textContent = (m.decoder_queue != null ? m.decoder_queue : "—") + "/" + (m.frame_queue != null ? m.frame_queue : "—");
      els.hudLead.textContent = state.backend === "webcodecs" ? state.lead + " ms" : "native";
    }
  }

  function pushChart(m) {
    var a = audioSummary();
    state.chart.push({
      t: Date.now(),
      fps: m.fps || 0,
      drift: a.audible_max_abs_ms == null ? null : a.audible_max_abs_ms,
      drop: m.dropped || 0
    });
    if (state.chart.length > 240) state.chart.shift();
  }

  function sampleMemory() {
    if (performance.memory && typeof performance.memory.usedJSHeapSize === "number") {
      state.memory = { js_heap_mb: +(performance.memory.usedJSHeapSize / 1048576).toFixed(2) };
    }
  }
  function onVisibility() {
    state.audio.visibilityEvents.push({ t_ms: Math.round(now()), hidden: document.hidden, state: document.visibilityState });
    if (state.run) state.run.events.push({ type: "visibility", hidden: document.hidden, state: document.visibilityState });
    if (document.hidden && state.playing) toast("Page is hidden. Playback may be throttled; keep this app in the foreground.");
  }

  /* ----------------------------------------------------------- diagnostics */

  function currentStats() {
    return state.liveStats || (state.lastRun && state.lastRun.stats) || null;
  }
  function renderMetrics() {
    var m = currentStats() || {};
    var a = state.run && !state.run.finalized ? audioSummary() : (state.lastRun && state.lastRun.audio) || audioSummary();
    var fps = m.fps_overall != null ? m.fps_overall : (m.fps != null ? m.fps : null);
    els.mFps.textContent = fps == null ? "—" : String(fps);
    els.mFpsSub.textContent = m.fps_media != null ? m.fps_media + " media fps" : (state.backend === "native" ? "native cadence" : "wall clock");
    var q = m.queue_drops || 0, l = m.late_drops || 0, b = m.burst_drops || 0;
    els.mDrops.textContent = String(m.dropped || 0);
    els.mDropsSub.textContent = q + " / " + l + " / " + b;
    els.mRebuf.textContent = String(m.rebuffers || 0);
    els.mRebufSub.textContent = (m.stalls || 0) + " stalls";
    els.mDrift.textContent = a.audible_max_abs_ms == null ? "—" : a.audible_max_abs_ms + " ms";
    els.mDriftSub.textContent = a.audible_mean_ms == null ? "mean —" : "mean " + a.audible_mean_ms + " ms";
    els.mDQ.textContent = m.decoder_queue == null ? "—" : String(m.decoder_queue);
    els.mDQSub.textContent = "max " + (m.decode_queue_max == null ? "—" : m.decode_queue_max);
    els.mFQ.textContent = m.frame_queue == null ? "—" : String(m.frame_queue);
    els.mFQSub.textContent = "max " + (m.frame_queue_max == null ? "—" : m.frame_queue_max);
    els.mLead.textContent = state.backend === "webcodecs" ? state.lead + " ms" : "native";
    els.mLeadSub.textContent = state.adaptive ? "adaptive" : "fixed";
    els.mErrors.textContent = String(m.errors || 0);
    els.mErrorsSub.textContent = (m.recoveries || 0) + " recoveries · " + (m.startup_recoveries || 0) + " startup";
    els.diagState.textContent = state.validation ? "validation " + state.validation.seconds + " s" : (state.playing ? "live" : (state.lastRun ? "result" : "idle"));
    els.diagState.className = "chip " + (state.playing ? "ok" : state.lastRun ? "warn" : "");
    els.runReason.textContent = state.lastRun ? (state.lastRun.reason + " · " + state.lastRun.ended_at) : "no completed run";
    drawChart();
  }

  function drawChart() {
    var c = els.chart;
    if (!c) return;
    var ctx = c.getContext("2d");
    var W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = "#22304a"; ctx.lineWidth = 1;
    for (var i = 1; i < 5; i++) {
      var y = (H / 5) * i;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    var data = state.chart.slice(-120);
    if (!data.length) {
      ctx.fillStyle = "#64748b"; ctx.font = "14px system-ui"; ctx.fillText("Playback data appears here.", 18, H / 2);
      els.chartNote.textContent = "waiting for playback";
      return;
    }
    els.chartNote.textContent = data.length + " samples · last " + data[data.length - 1].fps + " fps";
    var maxFps = 60;
    var drawLine = function (key, color, scale) {
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
      var started = false;
      for (var j = 0; j < data.length; j++) {
        var v = data[j][key];
        if (v == null) continue;
        var x = (j / Math.max(1, data.length - 1)) * W;
        var y = H - core.clamp(v * scale, 0, H);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      if (started) ctx.stroke();
    };
    drawLine("fps", "#5aa7ff", H / maxFps);
    drawLine("drift", "#f5b83d", H / 100);
  }

  function renderDiagnosticTable() {
    var t = els.diagTable;
    t.replaceChildren();
    var m = currentStats();
    var run = state.lastRun;
    if (!m) {
      var tr = document.createElement("tr"); var td = document.createElement("td");
      td.colSpan = 2; td.textContent = "No playback data yet."; tr.appendChild(td); t.appendChild(tr); return;
    }
    var row = function (k, v) {
      var tr = document.createElement("tr");
      var a = document.createElement("td"); a.textContent = k;
      var b = document.createElement("td"); b.textContent = v;
      tr.appendChild(a); tr.appendChild(b); t.appendChild(tr);
    };
    row("Title", state.item ? state.item.title : (run ? run.title : "—"));
    row("Backend / quality", (state.backend || (run && run.backend) || "—") + " / " + (state.quality || (run && run.quality) || "—"));
    row("Resolution", (m.width || (run && run.width) || "?") + "×" + (m.height || (run && run.height) || "?"));
    row("Presented / dropped", (m.presented || 0) + " / " + (m.dropped || 0));
    row("Drop reasons q/l/b", (m.queue_drops || 0) + " / " + (m.late_drops || 0) + " / " + (m.burst_drops || 0));
    row("Context loop/tick/startup", (m.loop_drops || 0) + " / " + (m.tick_gap_drops || 0) + " / " + (m.startup_drops || 0));
    row("Rebuffers / stalls", (m.rebuffers || 0) + " / " + (m.stalls || 0));
    row("Frame lifecycle", (m.frames_created == null ? "—" : m.frames_created) + " / " + (m.frames_closed == null ? "—" : m.frames_closed) + " / " + (m.frames_open == null ? "—" : m.frames_open));
    row("Seeks / preroll", (m.seeks || 0) + " / " + (m.seek_preroll || 0));
    row("Paint p50 / p95", (m.paint_p50_ms == null ? "—" : m.paint_p50_ms) + " / " + (m.paint_p95_ms == null ? "—" : m.paint_p95_ms) + " ms");
    row("Lead / queue max", (state.lead || m.lead_ms || "—") + " ms / " + (m.frame_queue_max == null ? "—" : m.frame_queue_max));
    row("Errors / recoveries", (m.errors || 0) + " / " + (m.recoveries || 0));
    var a = state.run && !state.run.finalized ? audioSummary() : (run && run.audio) || audioSummary();
    row("Audio mode", a.mode || "none");
    row("Audible drift mean/max", (a.audible_mean_ms == null ? "—" : a.audible_mean_ms) + " / " + (a.audible_max_abs_ms == null ? "—" : a.audible_max_abs_ms) + " ms");
    row("Scheduled drift mean/max", (a.scheduled_mean_ms == null ? "—" : a.scheduled_mean_ms) + " / " + (a.scheduled_max_abs_ms == null ? "—" : a.scheduled_max_abs_ms) + " ms");
    row("Output latency / resyncs", (a.output_latency_ms == null ? "—" : a.output_latency_ms) + " ms / " + (a.resyncs || 0));
    row("Wall / loops / reason", (m.wall_ms == null ? "—" : Math.round(m.wall_ms)) + " ms / " + (m.loops_completed == null ? "—" : m.loops_completed) + " / " + (m.reason || (run && run.reason) || "live"));
  }

  function renderHistory() {
    var b = els.historyBody;
    b.replaceChildren();
    state.history.slice().reverse().forEach(function (r) {
      var tr = document.createElement("tr");
      var cells = [
        (r.started_at || "").slice(11, 19),
        r.title || "—",
        r.backend || "—",
        r.quality || "—",
        r.stats && (r.stats.fps_overall != null ? r.stats.fps_overall : r.stats.fps) || "—",
        r.stats ? (r.stats.dropped || 0) : "—",
        r.stats ? (r.stats.rebuffers || 0) : "—",
        r.audio && r.audio.audible_max_abs_ms != null ? r.audio.audible_max_abs_ms + " ms" : "—"
      ];
      cells.forEach(function (v) { var td = document.createElement("td"); td.textContent = String(v); tr.appendChild(td); });
      b.appendChild(tr);
    });
    els.historyNote.textContent = state.history.length + " run" + (state.history.length === 1 ? "" : "s");
  }

  function renderDiagnostics() {
    renderMetrics(); renderDiagnosticTable(); renderHistory(); drawChart();
    els.jsonOut.value = buildJson();
    els.shortOut.textContent = buildShortCode();
    els.stopTestBtn.disabled = !state.validation;
  }
  function renderDiagnosticsExport() {
    els.jsonOut.value = buildJson();
    els.shortOut.textContent = buildShortCode();
  }

  function appInfo() {
    return {
      schema: "tesla-media-app-diagnostic/v1",
      app_version: VERSION,
      generated_at: new Date().toISOString(),
      parked_confirmed: state.parked,
      browser: {
        user_agent: navigator.userAgent,
        chromium_major: CAPS.chromium,
        hardware_concurrency: navigator.hardwareConcurrency || null,
        device_memory_gb: typeof navigator.deviceMemory === "number" ? navigator.deviceMemory : null,
        secure_context: CAPS.security,
        language: navigator.language || null
      },
      capabilities: CAPS,
      settings: {
        default_quality: state.defaultQuality, loop: state.loop, adaptive: state.adaptive,
        audio_sync: state.audioSync, volume: state.volume, muted: state.muted, lead_ms: state.lead
      },
      current: runSummary(state.run && !state.run.finalized ? state.run : state.lastRun),
      history: state.history.slice(-10).map(runSummary),
      errors: state.errors.slice(-50),
      logs: state.logs.slice(-50),
      memory: state.memory,
      visibility_events: state.audio.visibilityEvents.slice(-50),
      privacy: {
        uploads: false, analytics: false,
        network: "same-origin built-ins; user media URLs are opened by the native video element",
        diagnostics_storage: "in memory until copied or downloaded"
      }
    };
  }
  function runSummary(run) {
    if (!run) return null;
    return {
      id: run.id, started_at: run.started_at, ended_at: run.ended_at, reason: run.reason,
      item: { id: run.item_id, title: run.title },
      backend: run.backend, quality: run.quality, width: run.width, height: run.height,
      validation_seconds: run.validation_seconds,
      settings: run.settings,
      stats: run.stats || state.liveStats,
      audio: run.audio || audioSummary(),
      events: (run.events || []).slice(-100),
      errors: (run.errors || []).slice(-50)
    };
  }
  function buildJson() { return JSON.stringify(appInfo(), null, 2); }
  function buildShortCode() {
    var src = state.run && !state.run.finalized ? state.run : state.lastRun;
    var d = appInfo();
    if (src && src.stats) {
      d.backend = src.backend; d.quality = src.quality; d.run = src.stats; d.audio = src.audio || audioSummary();
    } else if (state.liveStats) {
      d.run = state.liveStats;
    }
    return core.makeShortCode(d);
  }
  function copyJson() {
    var text = buildJson();
    var fb = function () {
      els.jsonOut.focus(); els.jsonOut.select();
      try { document.execCommand("copy"); toast("Copied with fallback."); }
      catch (e) { toast("Copy blocked. Use Select all."); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast("Diagnostic JSON copied."); }, fb);
    else fb();
  }
  function downloadJson() {
    try {
      var blob = new Blob([buildJson()], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = "tesla-media-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
      document.body.appendChild(a); a.click();
      setTimeout(function () { try { document.body.removeChild(a); } catch (e) {} URL.revokeObjectURL(url); }, 1200);
      toast("Diagnostic JSON download started.");
    } catch (e) { toast("Download blocked. Use Copy JSON."); }
  }

  /* ------------------------------------------------------------- validation */

  function startValidation(seconds) {
    if (!state.parked) { els.gate.classList.remove("hidden"); return; }
    if (state.validation) { toast("A validation run is already active."); return; }
    var demo = state.library.filter(function (i) { return i.id === "demo-loop"; })[0];
    if (!demo) { toast("The built-in diagnostic item is missing."); return; }
    if (!CAPS.webcodecs) { toast("WebCodecs is unavailable; cannot run the H.264 validation."); return; }
    state.validation = { seconds: seconds, audioWas: state.audioSync };
    state.audioSync = true;
    state.adaptive = true;
    state.lead = 300;
    state.defaultQuality = "720p";
    els.settingsAudio.checked = true;
    els.validationStatus.textContent = "Running " + seconds + " s validation at 720p…";
    els.stopTestBtn.disabled = false;
    showView("diagnostics");
    loadItem(demo, "720p", 0, true, { runMs: seconds * 1000, validation: true });
    toast("Validation started: " + seconds + " s.");
  }

  /* -------------------------------------------------------------- add media */

  function addUserMediaFromForm() {
    var r = addUserMedia(els.urlTitle.value, els.urlValue.value, false);
    if (!r.ok) showUrlError(r.error);
    else { els.urlTitle.value = ""; els.urlValue.value = ""; showUrlError(""); }
  }
  function addUserMedia(title, url, fromApi) {
    var v = core.validateMediaUrl(url, location.href);
    if (!v.ok) return { ok: false, error: v.error };
    if (state.user.some(function (u) { return u.url === v.url; })) return { ok: false, error: "That URL is already in the library." };
    var t = core.sanitizeTitle(title);
    var item = { id: "user-" + Date.now().toString(36), title: t, url: v.url, added_at: new Date().toISOString() };
    state.user.push(item);
    saveUserMedia();
    rebuildLibrary();
    renderUserList();
    if (!fromApi) toast("Added “" + t + "”.");
    return { ok: true, item: item };
  }
  function removeUserMedia(id) {
    state.user = state.user.filter(function (u) { return u.id !== id; });
    saveUserMedia();
    if (state.item && state.item.id === id) stopPlayback("stop");
    rebuildLibrary(); renderUserList(); toast("Removed.");
  }
  function renderUserList() {
    var box = els.userMediaList;
    box.replaceChildren();
    if (!state.user.length) {
      var p = document.createElement("p"); p.className = "small"; p.textContent = "No user URLs added.";
      box.appendChild(p); return;
    }
    state.user.forEach(function (u) {
      var row = document.createElement("div"); row.className = "user-row";
      var d = document.createElement("div");
      var b = document.createElement("b"); b.textContent = u.title;
      var s = document.createElement("small"); s.textContent = u.url;
      d.appendChild(b); d.appendChild(s);
      var btn = document.createElement("button"); btn.className = "icon-btn"; btn.type = "button";
      btn.setAttribute("aria-label", "Remove " + u.title); btn.innerHTML = '<svg><use href="#i-trash"/></svg>';
      btn.addEventListener("click", function () { removeUserMedia(u.id); });
      row.appendChild(d); row.appendChild(btn); box.appendChild(row);
    });
  }
  function showUrlError(msg) {
    els.urlError.textContent = msg || "";
    els.urlError.hidden = !msg;
  }
  function resetLocal() {
    try { localStorage.removeItem(USER_KEY); localStorage.removeItem(SETTINGS_KEY); } catch (e) {}
    state.user = []; state.defaultQuality = "720p"; state.loop = true; state.adaptive = true;
    state.audioSync = false; state.volume = 0.8; state.muted = false;
    updateSettingsControls(); rebuildLibrary(); renderUserList(); applyVolume(); applyLoop();
    toast("Local settings and added URLs cleared.");
  }

  /* ------------------------------------------------------------------ keys */

  function onKey(e) {
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
    if (e.code === "Space") { e.preventDefault(); togglePlay(); }
    else if (e.code === "ArrowLeft") { e.preventDefault(); onSeekCommitTo(Math.max(0, state.positionMs - 5000)); }
    else if (e.code === "ArrowRight") { e.preventDefault(); onSeekCommitTo(Math.min(state.durationMs, state.positionMs + 5000)); }
    else if (e.key === "f" || e.key === "F") toggleFullscreen();
    else if (e.key === "m" || e.key === "M") toggleMute();
  }
  function onSeekCommitTo(ms) {
    state.positionMs = ms;
    els.seekBar.value = String(Math.round(ms));
    if (state.engine && state.engine.seek) state.engine.seek(ms);
  }

  /* ------------------------------------------------------------- test API */

  boot();

  window.__app = {
    version: VERSION,
    ready: true,
    getState: function () {
      return {
        parked: state.parked, view: state.view, playing: state.playing, paused: state.paused,
        loading: state.loading, error: state.error, backend: state.backend, quality: state.quality,
        positionMs: state.positionMs, durationMs: state.durationMs, lead: state.lead,
        loop: state.loop, volume: state.volume, muted: state.muted,
        item: state.item ? { id: state.item.id, title: state.item.title } : null,
        capabilities: CAPS
      };
    },
    getLibrary: function () { return state.library.map(function (i) { return { id: i.id, title: i.title, backend: i.backend, variants: i.variants || null, url: i.url || null }; }); },
    playItem: function (id, quality) {
      var item = state.library.filter(function (i) { return i.id === id; })[0];
      if (!item) return false;
      selectItem(item, quality);
      return true;
    },
    play: function () { if (!state.playing) togglePlay(); },
    pause: function () { if (state.playing) togglePlay(); },
    toggle: togglePlay,
    stop: function () { stopPlayback("stop"); },
    seek: function (ms) { onSeekCommitTo(ms); },
    setQuality: function (q) { setQuality(q); },
    setVolume: setVolume,
    toggleMute: toggleMute,
    setLoop: function (on) { state.loop = !!on; applyLoop(); },
    getDiagnostics: function () { return appInfo(); },
    exportJson: function () { return buildJson(); },
    getShortCode: function () { return buildShortCode(); },
    startValidation: startValidation,
    getHistory: function () { return state.history.slice(); },
    getLastRun: function () { return state.lastRun; },
    getEngineState: function () {
      if (!state.engine) return null;
      return {
        type: state.backend, ready: !!state.engine.ready, done: !!state.engine.done,
        everPlayed: !!state.engine.everPlayed, stats: state.engine.stats || null,
        info: state.engine.info || null, hasWorker: !!state.engine.worker,
        videoReady: state.engine.video ? state.engine.video.readyState : null
      };
    },
    addUserMedia: function (title, url) { return addUserMedia(title, url, true); },
    removeUserMedia: removeUserMedia,
    setAudioSync: function (on) {
      state.audioSync = !!on; els.settingsAudio.checked = state.audioSync;
      if (state.audioSync) prepareAudio().then(function () { if (state.playing) startTone(engineMediaSec()); });
      else stopTone();
    },
    showView: showView,
    confirmParked: function () { els.parkConfirm.checked = true; els.gateEnter.disabled = false; enterApp(); }
  };
  window.__appTest = {
    injectDecoderError: function () { if (state.engine && state.engine.injectError) state.engine.injectError(); },
    simulateCost: function (ms) { if (state.engine && state.engine.setSimulateCost) state.engine.setSimulateCost(ms); },
    setLead: function (ms) { state.lead = ms; if (state.engine && state.engine.setLead) state.engine.setLead(ms); }
  };
})();
