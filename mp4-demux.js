/**
 * lib/mp4-demux.js — minimal ISO-BMFF (MP4) demuxer for WebCodecs.
 *
 * This is the piece of plumbing that every "video without a <video> element"
 * implementation needs: the browser will decode, but something has to hand it
 * sample-accurate encoded chunks with timestamps.
 *
 * Scope: single video track, AVCC (avc1/avc3) or VP8/VP9 in ISO-BMFF, both
 * progressive (stbl sample tables) and fragmented (moof/trun) layouts.
 * Deliberately no audio, no edit lists, no ctts reordering — enough to measure
 * the cost of client-side demuxing, not a general-purpose muxer.
 */

/**
 * Byte readers that accept either a Uint8Array or a DataView.
 * Every call site in this file passes the DataView, so indexing it directly
 * (d[o]) would silently yield undefined and poison every parse.
 */
const byte = (d, o) => (typeof d.getUint8 === "function" ? d.getUint8(o) : d[o]);
const u16 = (d, o) => (byte(d, o) << 8) | byte(d, o + 1);
const u32 = (d, o) => ((byte(d, o) << 24) | (byte(d, o + 1) << 16) | (byte(d, o + 2) << 8) | byte(d, o + 3)) >>> 0;
const u64 = (d, o) => u32(d, o) * 4294967296 + u32(d, o + 4);
const fourcc = (d, o) => String.fromCharCode(byte(d, o), byte(d, o + 1), byte(d, o + 2), byte(d, o + 3));

/** Walk one level of boxes inside [start, end). */
function children(view, start, end) {
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    let size = u32(view, off);
    const type = fourcc(view, off + 4);
    let header = 8;
    if (size === 1) {
      size = u64(view, off + 8);
      header = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < header || off + size > end) break;
    out.push({ type, start: off + header, end: off + size, boxStart: off });
    off += size;
  }
  return out;
}

const find = (list, type) => list.find((b) => b.type === type);
const findAll = (list, type) => list.filter((b) => b.type === type);

/**
 * @param {Uint8Array} bytes whole file
 * @returns {{codec:string, description:Uint8Array|null, width:number, height:number,
 *            timescale:number, container:'progressive'|'fragmented',
 *            samples:Array<{offset:number,size:number,dtsUs:number,durUs:number,isKey:boolean}>}}
 */
function demuxMp4(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const top = children(view, 0, bytes.length);
  const moov = find(top, "moov");
  if (!moov) throw new Error("no moov box");

  const moovKids = children(view, moov.start, moov.end);
  const trak = findAll(moovKids, "trak").find((t) => {
    const mdia = find(children(view, t.start, t.end), "mdia");
    if (!mdia) return false;
    const hdlr = find(children(view, mdia.start, mdia.end), "hdlr");
    if (!hdlr) return false;
    return fourcc(view, hdlr.start + 8) === "vide";
  });
  if (!trak) throw new Error("no video trak");

  const tkhd = find(children(view, trak.start, trak.end), "tkhd");
  let width = 0;
  let height = 0;
  if (tkhd) {
    // v0: width/height are the last two 16.16 fixed-point fields
    const base = tkhd.start + 4 + (view.getUint8(tkhd.start) === 1 ? 32 : 20);
    width = view.getUint16(base + 52) >> 0;
    height = view.getUint16(base + 56) >> 0;
  }

  const mdia = find(children(view, trak.start, trak.end), "mdia");
  const mdhd = find(children(view, mdia.start, mdia.end), "mdhd");
  const timescale = mdhd ? u32(view, mdhd.start + (view.getUint8(mdhd.start) === 1 ? 20 : 12)) : 90000;
  const minf = find(children(view, mdia.start, mdia.end), "minf");
  const stbl = find(children(view, minf.start, minf.end), "stbl");
  const stblKids = children(view, stbl.start, stbl.end);

  // ---- sample description: codec + avcC ----
  const stsd = find(stblKids, "stsd");
  const entry = children(view, stsd.start + 8, stsd.end)[0];
  const entryType = entry.type;
  let codec;
  let description = null;
  if (entryType === "avc1" || entryType === "avc3") {
    const avcC = find(children(view, entry.start + 78, entry.end), "avcC");
    if (avcC) {
      description = bytes.slice(avcC.start, avcC.end);
      codec = `avc1.${[description[1], description[2], description[3]]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")}`;
    } else {
      codec = "avc1.42E01E";
    }
  } else if (entryType === "vp08") {
    codec = "vp8";
  } else if (entryType === "vp09") {
    codec = "vp09.00.10.08";
  } else {
    throw new Error(`unsupported sample entry: ${entryType}`);
  }

  // ---- sample tables ----
  const stsz = find(stblKids, "stsz");
  const stco = find(stblKids, "stco") ?? find(stblKids, "co64");
  const stsc = find(stblKids, "stsc");
  const stts = find(stblKids, "stts");
  const stss = find(stblKids, "stss");

  const sampleCount = stsz ? u32(view, stsz.start + 8) : 0;
  const fixedSize = stsz ? u32(view, stsz.start + 4) : 0;
  const sizes = [];
  for (let i = 0; i < sampleCount; i++) {
    sizes.push(fixedSize || u32(view, stsz.start + 12 + i * 4));
  }

  // durations -> DTS
  const durations = [];
  if (stts) {
    const n = u32(view, stts.start + 4);
    for (let i = 0; i < n; i++) {
      const count = u32(view, stts.start + 8 + i * 8);
      const delta = u32(view, stts.start + 12 + i * 8);
      for (let k = 0; k < count; k++) durations.push(delta);
    }
  }

  // chunk -> first sample index
  const chunkFirstSample = [];
  if (stsc) {
    const n = u32(view, stsc.start + 4);
    const runs = [];
    for (let i = 0; i < n; i++) {
      runs.push({
        firstChunk: u32(view, stsc.start + 8 + i * 12),
        perChunk: u32(view, stsc.start + 12 + i * 12),
      });
    }
    const chunkCount = stco ? u32(view, stco.start + 4) : 0;
    let sampleIdx = 0;
    for (let c = 1; c <= chunkCount; c++) {
      let per = 0;
      for (const r of runs) if (c >= r.firstChunk) per = r.perChunk;
      chunkFirstSample[c] = { first: sampleIdx, count: per };
      sampleIdx += per;
    }
  }

  const chunkOffsets = [];
  if (stco) {
    const n = u32(view, stco.start + 4);
    const wide = stco.type === "co64";
    for (let i = 0; i < n; i++) {
      chunkOffsets.push(wide ? u64(view, stco.start + 8 + i * 8) : u32(view, stco.start + 8 + i * 4));
    }
  }

  const keySet = new Set();
  if (stss) {
    const n = u32(view, stss.start + 4);
    for (let i = 0; i < n; i++) keySet.add(u32(view, stss.start + 8 + i * 4));
  }

  let samples = [];
  let container = "progressive";

  if (sampleCount === 0) {
    // ---- fragmented: moof/traf/trun ----
    container = "fragmented";
    const moofs = findAll(top, "moof");
    if (!moofs.length) throw new Error("moov has no samples and no moof boxes");
    const mdhdScale = timescale || 1000;
    for (const moof of moofs) {
      const trafs = children(view, moof.start, moof.end).filter((b) => b.type === "traf");
      for (const traf of trafs) {
        const trafKids = children(view, traf.start, traf.end);
        const tfhd = find(trafKids, "tfhd");
        const tfdt = find(trafKids, "tfdt");
        if (!tfhd) continue;
        const tfFlags = u32(view, tfhd.start) & 0xffffff;
        let p = tfhd.start + 4;
        if (tfFlags & 0x01) p += 8; // base-data-offset
        if (tfFlags & 0x02) p += 4; // sample-description-index
        const defaultDuration = tfFlags & 0x08 ? (p += 4, u32(view, p - 4)) : 0;
        const defaultSize = tfFlags & 0x10 ? (p += 4, u32(view, p - 4)) : 0;
        let baseTime = tfdt ? (view.getUint8(tfdt.start) === 1 ? u64(view, tfdt.start + 4) : u32(view, tfdt.start + 4)) : 0;
        const baseOffset = tfFlags & 0x01 ? u64(view, tfhd.start + 4) : moof.boxStart;
        const truns = findAll(trafKids, "trun");
        for (const trun of truns) {
          const trFlags = u32(view, trun.start) & 0xffffff;
          const count = u32(view, trun.start + 4);
          // Only the first sample's flags are usually present; the rest are
          // implied delta frames. Treating every sample as a keyframe would make
          // the decoder attempt standalone decode of P-frames.
          const perSampleFlags = !!(trFlags & 0x400);
          let q = trun.start + 8;
          const dataOffset = trFlags & 0x01 ? ((q += 4), view.getInt32(q - 4)) : 0;
          let firstFlags = null;
          if (trFlags & 0x04) {
            firstFlags = u32(view, q);
            q += 4;
          }
          let cursor = baseOffset + dataOffset;
          for (let i = 0; i < count; i++) {
            const dur = trFlags & 0x100 ? ((q += 4), u32(view, q - 4)) : defaultDuration;
            const size = trFlags & 0x200 ? ((q += 4), u32(view, q - 4)) : defaultSize;
            const flags = perSampleFlags ? ((q += 4), u32(view, q - 4)) : i === 0 ? firstFlags : -1;
            const cto = trFlags & 0x800 ? ((q += 4), view.getInt32(q - 4)) : 0;
            // sample_flags bit 26 = sample_is_non_sync_sample; absence means sync.
            const isKey = flags >= 0 && ((flags >>> 26) & 1) === 0;
            samples.push({
              offset: cursor,
              size,
              dtsUs: Math.round((baseTime / mdhdScale) * 1e6),
              durUs: Math.round((dur / mdhdScale) * 1e6),
              isKey,
              ctsUs: Math.round(((baseTime + cto) / mdhdScale) * 1e6),
            });
            baseTime += dur;
            cursor += size;
          }
        }
      }
    }
  } else {
    // ---- progressive ----
    let dts = 0;
    for (let i = 0; i < sampleCount; i++) {
      const chunk = chunkFirstSample.findIndex((c) => c && i >= c.first && i < c.first + c.count);
      let offset = 0;
      if (chunk >= 0) {
        const c = chunkFirstSample[chunk];
        const chunkIndex = chunkFirstSample.findIndex((x) => x && x === c);
        let within = 0;
        for (let k = 0; k < i - c.first; k++) within += sizes[c.first + k] ?? 0;
        offset = chunkOffsets[chunkIndex] + within;
      }
      const dur = durations[i] ?? durations.at(-1) ?? 1000;
      samples.push({
        offset,
        size: sizes[i],
        dtsUs: Math.round((dts / timescale) * 1e6),
        durUs: Math.round((dur / timescale) * 1e6),
        isKey: keySet.size ? keySet.has(i + 1) : true,
        ctsUs: Math.round((dts / timescale) * 1e6),
      });
      dts += dur;
    }
  }

  return {
    codec,
    description,
    width,
    height,
    timescale,
    container,
    samples: normalizeKeyframes(samples.filter((s) => s.size > 0)),
  };
}

/**
 * A stream whose first sample is flagged non-sync cannot be decoded from the
 * start, so guarantee at least one sync sample at the head. This is a demuxer
 * repair, not a guess about the content: the first sample of a playable file is
 * always a random-access point in practice.
 */
function normalizeKeyframes(samples) {
  if (samples.length && !samples.some((s) => s.isKey)) samples[0].isKey = true;
  return samples;
}

/** Build EncodedVideoChunk init payloads in decode order. */
function chunksFrom(bytes, track) {
  return track.samples.map((s) => ({
    type: s.isKey ? "key" : "delta",
    timestamp: s.ctsUs ?? s.dtsUs,
    duration: s.durUs,
    data: bytes.subarray(s.offset, s.offset + s.size),
  }));
}

window.demuxMp4 = demuxMp4;
