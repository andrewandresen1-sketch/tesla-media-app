/**
 * decoder-worker.js — Phase 13 decode/present worker.
 *
 * Derived from the Phase 11/12 player worker that was desktop-validated and
 * vehicle-guided. The worker owns the OffscreenCanvas and never transfers
 * VideoFrames to the main thread. The main thread only decodes the MP4
 * container and posts ticks; this file receives encoded bytes and timestamps.
 *
 * Messages in:
 *   init {canvas, config, samples, bytes, options}
 *   play | pause | resume | stop | tick
 *   seek {time_ms}
 *   setLead {lead_ms}
 *   setLoop {loop_forever}
 *   setRunDuration {run_ms}
 *   setSimulateCost {ms}
 *   simulateError            (test hook)
 *   time                     (reply with current media position)
 */
"use strict";

var ctx = null, canvasW = 1280, canvasH = 720;
var config = null, samples = null, bytes = null;
var decoder = null;
var opts = {
  leadMs: 300,
  maxDecodeQueue: 6,
  maxFrameQueue: 14,
  autoFrameQueue: true,
  lateMs: 50,
  loops: 1,
  loopForever: true,
  runMs: 0,
  targetFps: 30,
  simulateFrameCostMs: 0
};
var playing = false, stopped = false, started = false;
var driver = 0;
var firstTsUs = 0, durationUs = 0, mediaOffsetUs = 0, playbackStart = 0;
var loopOffsetUs = 0, skipUntilUs = 0;
var nextSample = 0, frames = [], flushed = false, done = false, loop = 0;
var startedAt = 0, lastStatsAt = 0, lastPresentedAt = 0;
var stallSince = 0, rebuffering = false, rebufferTimer = 0, startupTimer = 0;
var stats = {
  presented: 0, dropped: 0, late: 0, stalls: 0, rebuffers: 0,
  errors: 0, recoveries: 0, decodeQueueMax: 0, frameQueueMax: 0,
  queueDrops: 0, submitted: 0, ticks: 0, presentCalls: 0,
  lateDrops: 0, burstDrops: 0, startupDrops: 0, loopDrops: 0, tickGapDrops: 0,
  startupRecoveries: 0, seeks: 0, seekPreroll: 0,
  tickGaps: 0, tickGapMax: 0, currentTickGap: 0, lastTickAt: 0, loopWindowUntil: 0,
  framesCreated: 0, framesClosed: 0, dropEvents: [],
  paintMs: [], bufferedMinMs: null, bufferedMaxMs: 0,
  firstFrameTs: null, lastFrameTs: null, firstPresentedTs: null, lastPresentedTs: null,
  firstPresentedAt: 0, beeps: 0, lastBeepSec: -1, syncCorrections: 0
};

function now() { return performance.now(); }
function post(msg) { self.postMessage(msg); }
function startDriver() {
  if (driver) return;
  // The worker owns its clock. A main-thread rAF pump freezes when the page is
  // occluded or idle; this interval keeps presentation and diagnostics alive.
  driver = setInterval(function () {
    if (!stopped && !done && (playing || rebuffering)) tick();
  }, 16);
}
function stopDriver() {
  if (driver) { clearInterval(driver); driver = 0; }
}
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
function percentile(values, p) {
  if (!values.length) return null;
  var v = values.slice().sort(function (a, b) { return a - b; });
  var i = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return +v[i].toFixed(3);
}
function mediaNowUs() {
  if (!playing) return firstTsUs + mediaOffsetUs;
  return firstTsUs + mediaOffsetUs + (now() - playbackStart) * 1000;
}
function loopPositionUs() {
  var abs = mediaNowUs() - firstTsUs;
  return ((abs % durationUs) + durationUs) % durationUs;
}
function closeFrame(frame) {
  try { frame.close(); } catch (e) { /* ignore */ }
  stats.framesClosed++;
}
function closeQueued() {
  for (var i = 0; i < frames.length; i++) closeFrame(frames[i].frame);
  frames = [];
}
function recordDrop(reason, tsUs) {
  if (stats.presented === 0) stats.startupDrops++;
  if (now() < stats.loopWindowUntil) stats.loopDrops++;
  if (stats.currentTickGap > 50) stats.tickGapDrops++;
  if (stats.dropEvents.length < 250) {
    stats.dropEvents.push({
      reason: reason,
      media_ms: Math.round((tsUs - firstTsUs) / 1000),
      loop: loop,
      tick_gap_ms: Math.round(stats.currentTickGap)
    });
  }
}

function makeDecoder() {
  if (decoder) { try { decoder.close(); } catch (e) {} }
  decoder = new VideoDecoder({ output: onFrame, error: onError });
  decoder.configure(config);
}

function armStartupWatchdog() {
  if (startupTimer) clearTimeout(startupTimer);
  startupTimer = setTimeout(function () {
    if (stopped || done || stats.presented > 0) return;
    if (stats.startupRecoveries >= 2) {
      post({ type: "log", message: "startup watchdog: no frame after 2 recoveries" });
      finish("startup-failed");
      return;
    }
    stats.startupRecoveries++;
    post({ type: "log", message: "startup watchdog: recreating decoder" });
    closeQueued();
    nextSample = 0; loop = 0; loopOffsetUs = 0; flushed = false;
    mediaOffsetUs = 0; playbackStart = now() + 150; playing = true;
    skipUntilUs = 0;
    try { decoder.close(); } catch (e) {}
    decoder = null;
    makeDecoder();
    armStartupWatchdog();
  }, 5000);
}

function onFrame(frame) {
  stats.framesCreated++;
  // Frames between the keyframe and the seek target are required for decoding
  // references but are not presentation candidates. Discard them before they
  // reach the frame queue; otherwise a seek looks like a queue overflow.
  if (skipUntilUs && frame.timestamp < skipUntilUs) {
    stats.seekPreroll++;
    closeFrame(frame);
    return;
  }
  if (stats.firstFrameTs === null) stats.firstFrameTs = frame.timestamp;
  stats.lastFrameTs = frame.timestamp;
  if (frames.length >= opts.maxFrameQueue) {
    stats.queueDrops++;
    stats.dropped++;
    recordDrop("queue", frame.timestamp);
    closeFrame(frame);
    return;
  }
  frames.push({ frame: frame, tsUs: frame.timestamp });
  stats.frameQueueMax = Math.max(stats.frameQueueMax, frames.length);
}

function onError(e) {
  if (done) return;
  stats.errors++;
  post({ type: "error", message: String((e && e.message) || e), recoveries: stats.recoveries });
  recover();
}

function recover() {
  if (stopped) { finish("error"); return; }
  if (stats.recoveries >= 3) { finish("error"); return; }
  stats.recoveries++;
  var target = loopPositionUs() / 1e6;
  post({ type: "log", message: "recovering at " + target.toFixed(2) + " s" });
  seekTo(target, false);
}

function submit() {
  var media = mediaNowUs();
  while (nextSample < samples.length && !stopped) {
    var s = samples[nextSample];
    var sampleAbsUs = s.ctsUs + loopOffsetUs;
    if (sampleAbsUs > media + opts.leadMs * 1000) break;
    if (decoder.decodeQueueSize >= opts.maxDecodeQueue) break;
    if (frames.length >= opts.maxFrameQueue) break;
    if (opts.simulateFrameCostMs > 0) {
      var until = now() + opts.simulateFrameCostMs;
      while (now() < until) { /* synthetic load for desktop validation */ }
    }
    try {
      decoder.decode(new EncodedVideoChunk({
        type: s.isKey ? "key" : "delta",
        timestamp: sampleAbsUs,
        duration: s.durUs,
        data: bytes.subarray(s.offset, s.offset + s.size)
      }));
    } catch (e) { onError(e); break; }
    stats.decodeQueueMax = Math.max(stats.decodeQueueMax, decoder.decodeQueueSize);
    stats.submitted++;
    nextSample++;
  }
  if (!opts.loopForever && nextSample >= samples.length && !flushed && loop + 1 >= opts.loops) {
    flushed = true;
    try { decoder.flush().catch(onError); } catch (e) { onError(e); }
  }
}

function present() {
  var media = mediaNowUs();
  var due = [];
  while (frames.length && frames[0].tsUs <= media + 2000) due.push(frames.shift());
  if (!due.length) return;

  var usable = [];
  for (var i = 0; i < due.length; i++) {
    if (skipUntilUs && due[i].tsUs < skipUntilUs) {
      stats.seekPreroll++;
      closeFrame(due[i].frame);
    } else {
      usable.push(due[i]);
    }
  }
  if (!usable.length) return;
  skipUntilUs = 0;

  var chosen = usable[usable.length - 1];
  for (var d = 0; d < usable.length - 1; d++) {
    stats.burstDrops++;
    stats.dropped++;
    stats.late++;
    recordDrop("burst", usable[d].tsUs);
    closeFrame(usable[d].frame);
  }
  var lateUs = media - chosen.tsUs;
  if (lateUs > opts.lateMs * 1000) {
    stats.lateDrops++;
    stats.dropped++;
    stats.late++;
    recordDrop("late", chosen.tsUs);
    closeFrame(chosen.frame);
    return;
  }
  var t = now();
  try { ctx.drawImage(chosen.frame, 0, 0, canvasW, canvasH); } catch (e) { /* ignore */ }
  stats.paintMs.push(now() - t);
  closeFrame(chosen.frame);
  stats.presented++;
  if (stats.firstPresentedTs === null) {
    stats.firstPresentedTs = chosen.tsUs;
    post({ type: "first_frame", tsUs: chosen.tsUs });
  }
  if (!stats.firstPresentedAt) stats.firstPresentedAt = now();
  var sec = Math.floor(chosen.tsUs / 1e6);
  if (sec !== stats.lastBeepSec) {
    stats.lastBeepSec = sec;
    stats.beeps++;
    post({ type: "beep", sec: sec });
  }
  stats.lastPresentedTs = chosen.tsUs;
  lastPresentedAt = now();
}

function bufferedAheadMs() {
  if (nextSample <= 0) return 0;
  return Math.max(0, (samples[nextSample - 1].ctsUs + loopOffsetUs - mediaNowUs()) / 1000);
}

function startRebuffer() {
  if (rebuffering || stopped) return;
  rebuffering = true;
  stats.rebuffers++;
  playing = false;
  post({ type: "log", message: "rebuffering" });
  rebufferTimer = setInterval(function () {
    if (stopped || frames.length >= 2 || nextSample >= samples.length) {
      clearInterval(rebufferTimer); rebufferTimer = 0;
      mediaOffsetUs = (frames.length ? frames[0].tsUs : mediaNowUs()) - firstTsUs;
      playbackStart = now() + 80;
      playing = true;
      rebuffering = false;
    }
  }, 50);
}

function checkUnderrun() {
  if (!playing || rebuffering) return;
  if (frames.length === 0 && nextSample < samples.length && lastPresentedAt > 0) {
    var silent = now() - lastPresentedAt;
    if (silent > 150) {
      if (!stallSince) { stallSince = now(); stats.stalls++; }
      if (silent > 500) { stallSince = 0; startRebuffer(); }
    }
  } else {
    stallSince = 0;
  }
}

function restartLoop() {
  loop++;
  loopOffsetUs = loop * durationUs;
  nextSample = 0;
  flushed = false;
  stats.loopWindowUntil = now() + 150;
  post({ type: "log", message: "loop " + (loop + 1) });
}

function seekTo(timeSec, countSeek) {
  if (!samples || !samples.length || done) return;
  var targetUs = clamp(Number(timeSec) * 1e6 || 0, 0, Math.max(0, durationUs - 1));
  var loopBase = loop * durationUs;
  var idx = 0;
  for (var i = 0; i < samples.length; i++) {
    if (samples[i].isKey && samples[i].ctsUs <= targetUs) idx = i;
  }
  if (rebufferTimer) { clearInterval(rebufferTimer); rebufferTimer = 0; }
  rebuffering = false; stallSince = 0;
  closeQueued();
  try { decoder.reset(); decoder.configure(config); } catch (e) { makeDecoder(); }
  nextSample = idx;
  loopOffsetUs = loopBase;
  flushed = false;
  mediaOffsetUs = loopBase + targetUs;
  playbackStart = now();
  playing = true;
  skipUntilUs = loopBase + targetUs;
  stats.loopWindowUntil = 0;
  if (countSeek !== false) stats.seeks++;
  post({ type: "seeked", time_ms: Math.round(targetUs / 1000), media_ms: Math.round((loopBase + targetUs) / 1000), loop: loop });
}

function finish(reason) {
  if (done) return;
  done = true;
  stopped = true;
  playing = false;
  stopDriver();
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = 0; }
  if (rebufferTimer) { clearInterval(rebufferTimer); rebufferTimer = 0; }
  closeQueued();
  try { if (decoder) decoder.close(); } catch (e) {}
  var wall = startedAt ? now() - startedAt : 0;
  post({
    type: "done",
    reason: reason || "end",
    stats: {
      presented: stats.presented,
      dropped: stats.dropped,
      late: stats.late,
      stalls: stats.stalls,
      rebuffers: stats.rebuffers,
      errors: stats.errors,
      recoveries: stats.recoveries,
      startup_recoveries: stats.startupRecoveries,
      decode_queue_max: stats.decodeQueueMax,
      frame_queue_max: stats.frameQueueMax,
      queue_drops: stats.queueDrops,
      late_drops: stats.lateDrops,
      burst_drops: stats.burstDrops,
      startup_drops: stats.startupDrops,
      loop_drops: stats.loopDrops,
      tick_gap_drops: stats.tickGapDrops,
      tick_gaps: stats.tickGaps,
      tick_gap_max_ms: +stats.tickGapMax.toFixed(1),
      frames_created: stats.framesCreated,
      frames_closed: stats.framesClosed,
      frames_open: frames.length,
      drop_events: stats.dropEvents,
      submitted: stats.submitted,
      ticks: stats.ticks,
      present_calls: stats.presentCalls,
      seeks: stats.seeks,
      seek_preroll: stats.seekPreroll,
      first_frame_ts: stats.firstFrameTs,
      last_frame_ts: stats.lastFrameTs,
      first_presented_ts: stats.firstPresentedTs,
      last_presented_ts: stats.lastPresentedTs,
      paint_p50_ms: percentile(stats.paintMs, 50),
      paint_p95_ms: percentile(stats.paintMs, 95),
      paint_max_ms: stats.paintMs.length ? +Math.max.apply(null, stats.paintMs).toFixed(3) : null,
      buffered_min_ms: stats.bufferedMinMs,
      buffered_max_ms: stats.bufferedMaxMs,
      loops_completed: loop + 1,
      beeps: stats.beeps,
      sync_corrections: stats.syncCorrections,
      startup_ms: stats.firstPresentedAt ? +(stats.firstPresentedAt - startedAt).toFixed(1) : null,
      wall_ms: +wall.toFixed(1),
      duration_ms: +((durationUs) / 1000).toFixed(2),
      position_ms: +(loopPositionUs() / 1000).toFixed(1),
      lead_ms: opts.leadMs,
      run_ms: opts.runMs,
      loop_forever: opts.loopForever,
      reason: reason || "end",
      fps_overall: wall > 0 ? +((stats.presented / wall) * 1000).toFixed(2) : 0,
      fps_media: (stats.firstPresentedTs != null && stats.lastPresentedTs != null && stats.lastPresentedTs > stats.firstPresentedTs)
        ? +(((stats.presented - 1) / ((stats.lastPresentedTs - stats.firstPresentedTs) / 1e6))).toFixed(2)
        : null
    }
  });
}

function tick() {
  if (stopped || done) return;
  if (opts.runMs > 0 && startedAt && (now() - startedAt) >= opts.runMs) {
    finish("duration");
    return;
  }
  var tickNow = now();
  if (stats.lastTickAt) {
    var tickGap = tickNow - stats.lastTickAt;
    stats.currentTickGap = tickGap;
    if (tickGap > 50) {
      stats.tickGaps++;
      stats.tickGapMax = Math.max(stats.tickGapMax, tickGap);
    }
  }
  stats.lastTickAt = tickNow;
  stats.ticks++;
  if (playing || rebuffering) {
    submit();
    if (playing) { stats.presentCalls++; present(); }
    var b = bufferedAheadMs();
    if (stats.bufferedMinMs === null || b < stats.bufferedMinMs) stats.bufferedMinMs = b;
    if (b > stats.bufferedMaxMs) stats.bufferedMaxMs = b;
    checkUnderrun();
    if (nextSample >= samples.length && !rebuffering) {
      if (opts.loopForever || loop + 1 < opts.loops) {
        restartLoop();
      } else if (flushed && frames.length === 0 && decoder.decodeQueueSize === 0) {
        finish("end");
      }
    }
  }
  var t = now();
  if (t - lastStatsAt > 500) {
    lastStatsAt = t;
    var wall = startedAt ? (t - startedAt) / 1000 : 0;
    post({
      type: "stats",
      presented: stats.presented,
      dropped: stats.dropped,
      late: stats.late,
      stalls: stats.stalls,
      rebuffers: stats.rebuffers,
      errors: stats.errors,
      recoveries: stats.recoveries,
      startup_recoveries: stats.startupRecoveries,
      decoder_queue: decoder ? decoder.decodeQueueSize : 0,
      frame_queue: frames.length,
      media_time_ms: Math.max(0, (mediaNowUs() - firstTsUs) / 1000),
      position_ms: +(loopPositionUs() / 1000).toFixed(1),
      loop: loop,
      duration_ms: +(durationUs / 1000).toFixed(2),
      buffered_ahead_ms: Math.round(bufferedAheadMs()),
      fps: wall > 0 ? +((stats.presented / wall)).toFixed(2) : 0,
      fps_overall: wall > 0 ? +((stats.presented / wall)).toFixed(2) : 0,
      paint_p50_ms: percentile(stats.paintMs, 50),
      queue_drops: stats.queueDrops,
      late_drops: stats.lateDrops,
      burst_drops: stats.burstDrops,
      startup_drops: stats.startupDrops,
      loop_drops: stats.loopDrops,
      tick_gap_drops: stats.tickGapDrops,
      tick_gap_max_ms: +stats.tickGapMax.toFixed(1),
      frames_created: stats.framesCreated,
      frames_closed: stats.framesClosed,
      frames_open: frames.length,
      seeks: stats.seeks,
      seek_preroll: stats.seekPreroll,
      next_sample: nextSample,
      skip_until_ms: +(skipUntilUs / 1000).toFixed(1),
      media_offset_ms: +(mediaOffsetUs / 1000).toFixed(1),
      loop_offset_ms: +(loopOffsetUs / 1000).toFixed(1),
      lead_ms: opts.leadMs,
      run_ms: opts.runMs
    });
  }
}

self.onerror = function (e) {
  try { post({ type: "log", message: "worker exception: " + ((e && e.message) || e) }); } catch (x) {}
};
self.addEventListener("unhandledrejection", function (e) {
  try { post({ type: "log", message: "worker rejection: " + ((e.reason && e.reason.message) || e.reason) }); } catch (x) {}
});

self.onmessage = function (ev) {
  var m = ev.data || {};
  if (m.type === "init") {
    ctx = m.canvas.getContext("2d", { alpha: false });
    canvasW = m.canvas.width; canvasH = m.canvas.height;
    config = m.config; samples = m.samples; bytes = new Uint8Array(m.bytes);
    opts.leadMs = m.options.leadMs || 300;
    opts.maxDecodeQueue = m.options.maxDecodeQueue || 6;
    opts.autoFrameQueue = m.options.autoFrameQueue !== false;
    opts.maxFrameQueue = m.options.maxFrameQueue || Math.min(24, Math.ceil(opts.leadMs / 33) + 4);
    opts.lateMs = m.options.lateMs || 50;
    opts.loops = m.options.loops || 1;
    opts.loopForever = m.options.loopForever !== false;
    opts.runMs = m.options.runMs || 0;
    opts.targetFps = m.options.targetFps || 30;
    opts.simulateFrameCostMs = m.options.simulateFrameCostMs || 0;
    firstTsUs = samples.length ? samples[0].ctsUs : 0;
    var last = samples.length ? samples[samples.length - 1] : { ctsUs: 0, durUs: 0 };
    durationUs = Math.max(1, last.ctsUs + last.durUs - firstTsUs);
    post({
      type: "ready",
      worker_video_decoder: typeof VideoDecoder !== "undefined",
      samples: samples.length,
      width: canvasW,
      height: canvasH,
      duration_us: durationUs,
      codec: config && config.codec
    });
    tick();
  } else if (m.type === "play") {
    if (!decoder) makeDecoder();
    if (!started) { started = true; startedAt = now(); }
    if (!playing) { playbackStart = now() + 120; playing = true; }
    armStartupWatchdog();
    startDriver();
    tick();
  } else if (m.type === "tick") {
    tick();
  } else if (m.type === "sync") {
    var corrUs = clamp((m.drift_ms || 0) * 1000 * 0.3, -10000, 10000);
    if (Math.abs(corrUs) > 100) {
      mediaOffsetUs += corrUs;
      stats.syncCorrections++;
    }
  } else if (m.type === "pause") {
    if (playing) {
      mediaOffsetUs = mediaNowUs() - firstTsUs;
      playing = false;
    }
    stopDriver();
  } else if (m.type === "resume") {
    if (!playing && !done) {
      if (!decoder) makeDecoder();
      playbackStart = now();
      playing = true;
      armStartupWatchdog();
      startDriver();
    }
  } else if (m.type === "seek") {
    seekTo((m.time_ms || 0) / 1000, true);
    startDriver();
  } else if (m.type === "setLead") {
    opts.leadMs = clamp(m.lead_ms || 300, 150, 1000);
    if (opts.autoFrameQueue) opts.maxFrameQueue = Math.min(24, Math.ceil(opts.leadMs / 33) + 4);
    post({ type: "lead", lead_ms: opts.leadMs, frame_queue: opts.maxFrameQueue });
  } else if (m.type === "setLoop") {
    opts.loopForever = m.loop_forever !== false;
    if (opts.loopForever) flushed = false;
  } else if (m.type === "setRunDuration") {
    opts.runMs = Math.max(0, Number(m.run_ms) || 0);
  } else if (m.type === "setSimulateCost") {
    opts.simulateFrameCostMs = Math.max(0, Number(m.ms) || 0);
  } else if (m.type === "time") {
    post({ type: "time", media_ms: Math.max(0, (mediaNowUs() - firstTsUs) / 1000), loop: loop });
  } else if (m.type === "simulateError") {
    onError(new Error("simulated decoder failure"));
  } else if (m.type === "stop") {
    finish("stop");
  }
};
