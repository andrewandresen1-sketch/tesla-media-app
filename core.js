/**
 * core.js — pure helpers shared by the app and the Node tests.
 *
 * No DOM, no network, no globals other than the export. Written as a UMD-ish
 * classic script so the browser can load it with <script src> (no bundler) and
 * Node can require() it.
 */
(function (root) {
  "use strict";

  var QUALITIES = ["360p", "540p", "720p"];
  var APP_VERSION = "phase13-1";

  function clamp(n, lo, hi) {
    n = Number(n);
    if (!isFinite(n)) return lo;
    return Math.min(hi, Math.max(lo, n));
  }

  function round(n, digits) {
    var f = Math.pow(10, digits == null ? 1 : digits);
    return Math.round(Number(n) * f) / f;
  }

  function formatTime(ms) {
    ms = Math.max(0, Number(ms) || 0);
    var total = Math.floor(ms / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    if (h > 0) return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
    return m + ":" + String(s).padStart(2, "0");
  }

  function qualityRank(q) {
    var i = QUALITIES.indexOf(q);
    return i < 0 ? -1 : i;
  }

  function chooseVariant(item, preferred) {
    if (!item || !item.variants || !item.variants.length) return null;
    var list = item.variants.slice().sort(function (a, b) { return qualityRank(a.quality) - qualityRank(b.quality); });
    for (var i = 0; i < list.length; i++) if (list[i].quality === preferred) return list[i];
    for (var j = 0; j < list.length; j++) if (list[j].quality === item.defaultQuality) return list[j];
    return list[list.length - 1];
  }

  function chooseBackend(item, caps) {
    caps = caps || {};
    if (!item) return "none";
    if (item.backend === "native") return caps.native === false ? "none" : "native";
    if (item.backend === "webcodecs") return caps.webcodecs ? "webcodecs" : (caps.native ? "native" : "none");
    if (item.variants && item.variants.length && caps.webcodecs && item.container === "mp4") return "webcodecs";
    return caps.native ? "native" : "none";
  }

  function validateMediaUrl(value, base) {
    var raw = String(value == null ? "" : value).trim();
    if (!raw) return { ok: false, error: "Enter a media URL." };
    if (raw.length > 2048) return { ok: false, error: "URL is too long." };
    var parsed;
    try { parsed = new URL(raw, base || "https://example.invalid/"); }
    catch (e) { return { ok: false, error: "That is not a valid URL." }; }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { ok: false, error: "Only http:// and https:// media URLs are allowed." };
    }
    if (parsed.username || parsed.password) {
      return { ok: false, error: "URLs with embedded credentials are not allowed." };
    }
    return { ok: true, url: parsed.href, origin: parsed.origin };
  }

  function sanitizeTitle(value) {
    return String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120) || "Untitled media";
  }

  function adaptiveLead(current, signal) {
    var lead = clamp(current || 300, 300, 600);
    signal = signal || {};
    if ((signal.rebuffersDelta || 0) > 0 || (signal.queueDropsDelta || 0) >= 5) {
      return clamp(lead + 150, 300, 600);
    }
    if ((signal.stableMs || 0) >= 60000 && lead > 300) {
      return clamp(lead - 150, 300, 600);
    }
    return lead;
  }

  function frameQueueFor(leadMs) {
    return Math.min(24, Math.ceil(clamp(leadMs, 150, 1000) / 33) + 4);
  }

  function makeShortCode(d) {
    d = d || {};
    var run = d.run || {};
    var audio = d.audio || {};
    return [
      "T13",
      "v=" + (d.app_version || APP_VERSION),
      "backend=" + (d.backend || "?"),
      "q=" + (d.quality || "?"),
      "fps=" + (run.fps_overall == null ? "?" : round(run.fps_overall, 2)),
      "pres=" + (run.presented == null ? "?" : run.presented),
      "drop=" + (run.dropped == null ? "?" : run.dropped),
      "qdrop=" + (run.queue_drops || 0),
      "ldrop=" + (run.late_drops || 0),
      "bdrop=" + (run.burst_drops || 0),
      "loop=" + (run.loop_drops || 0),
      "rebuf=" + (run.rebuffers || 0),
      "adrift=" + (audio.audible_max_abs_ms == null ? "?" : round(audio.audible_max_abs_ms, 1)),
      "sdrift=" + (audio.scheduled_max_abs_ms == null ? "?" : round(audio.scheduled_max_abs_ms, 1)),
      "err=" + ((d.errors && d.errors.length) || 0),
      "dur=" + (run.wall_ms == null ? "?" : Math.round(run.wall_ms))
    ].join("|");
  }

  var api = {
    APP_VERSION: APP_VERSION,
    QUALITIES: QUALITIES,
    clamp: clamp,
    round: round,
    formatTime: formatTime,
    qualityRank: qualityRank,
    chooseVariant: chooseVariant,
    chooseBackend: chooseBackend,
    validateMediaUrl: validateMediaUrl,
    sanitizeTitle: sanitizeTitle,
    adaptiveLead: adaptiveLead,
    frameQueueFor: frameQueueFor,
    makeShortCode: makeShortCode
  };

  root.TeslaMediaCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
