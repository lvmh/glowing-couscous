// Node-based BPM regression test runner.
// Scans WAV files in ../public, derives expected BPM from filenames, and
// compares against a standalone copy of the app's BPM detector.

const fs = require("fs");
const path = require("path");

// ---- Minimal WAV decoder (16‑bit PCM, mono/stereo) ----

function decodeWavToMonoFloat32(filePath) {
  const buf = fs.readFileSync(filePath);

  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`Unsupported WAV format in ${filePath}`);
  }

  let offset = 12;
  let audioFormat = null;
  let numChannels = null;
  let sampleRate = null;
  let bitsPerSample = null;
  let dataOffset = null;
  let dataSize = null;

  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;

    if (chunkId === "fmt ") {
      audioFormat = buf.readUInt16LE(chunkDataOffset);
      numChannels = buf.readUInt16LE(chunkDataOffset + 2);
      sampleRate = buf.readUInt32LE(chunkDataOffset + 4);
      bitsPerSample = buf.readUInt16LE(chunkDataOffset + 14);
    } else if (chunkId === "data") {
      dataOffset = chunkDataOffset;
      dataSize = chunkSize;
      break;
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (
    audioFormat !== 1 ||
    !numChannels ||
    !sampleRate ||
    !bitsPerSample ||
    dataOffset == null ||
    dataSize == null
  ) {
    throw new Error(`Unsupported WAV structure in ${filePath}`);
  }

  if (bitsPerSample !== 16) {
    throw new Error(`Only 16‑bit PCM WAV is supported (${bitsPerSample}‑bit found) in ${filePath}`);
  }

  const bytesPerSample = bitsPerSample / 8;
  const totalSamples = dataSize / bytesPerSample;
  const samplesPerChannel = totalSamples / numChannels;

  const channelData = new Float32Array(samplesPerChannel);
  for (let i = 0; i < samplesPerChannel; i++) {
    const byteOffset = dataOffset + (i * numChannels) * bytesPerSample;
    const intSample = buf.readInt16LE(byteOffset);
    channelData[i] = intSample / 32768;
  }

  return { channelData, sampleRate };
}

// ---- Standalone BPM detector (kept in sync with lib/audio-engine.ts) ----

/**
 * Detect BPM using multi-band onset detection + harmonic-sum ACF scoring
 * combined with track-length bar-alignment to resolve octave ambiguity.
 *
 * Output is always folded into the 80–160 BPM range since that's the
 * working range for this production context (tracks are written in
 * double-time where necessary).
 */
function detectBpmFromSignal(channelData, sampleRate) {
  const MIN_FOLD = 80;   // fold output into this range
  const MAX_FOLD = 160;

  // Wide search range so half-tempo candidates (e.g. 66 BPM → 132) are found
  const SEARCH_MIN = 40;
  const SEARCH_MAX = 220;

  // Track duration — used for bar-alignment scoring
  const trackDuration = channelData.length / sampleRate;

  // 1. Limit analysis to first 60s for speed
  const maxSamples = Math.min(channelData.length, sampleRate * 60);

  // 2. Downsample to ~8000 Hz with averaging for anti-alias
  const TARGET_RATE = 8000;
  const factor = Math.max(1, Math.floor(sampleRate / TARGET_RATE));
  const dsRate = sampleRate / factor;
  const nDS = Math.floor(maxSamples / factor);

  const ds = new Float32Array(nDS);
  for (let i = 0; i < nDS; i++) {
    let s = 0;
    for (let j = 0; j < factor; j++) s += channelData[i * factor + j] || 0;
    ds[i] = s / factor;
  }

  // 2b. Detect musical end before reverb/tail to prevent duration skew
  const musEndWin = Math.max(1, Math.round(dsRate));
  const nMusFrames = Math.max(1, Math.floor(nDS / musEndWin));
  const musFrameRms = new Float32Array(nMusFrames);
  let peakMusRms = 0;
  for (let i = 0; i < nMusFrames; i++) {
    let e = 0;
    const end = Math.min((i + 1) * musEndWin, nDS);
    for (let j = i * musEndWin; j < end; j++) e += ds[j] * ds[j];
    musFrameRms[i] = Math.sqrt(e / (end - i * musEndWin));
    if (musFrameRms[i] > peakMusRms) peakMusRms = musFrameRms[i];
  }
  let musEndFrame = nMusFrames - 1;
  for (let i = nMusFrames - 1; i >= 0; i--) {
    if (musFrameRms[i] > peakMusRms * 0.03) { musEndFrame = i; break; }
  }
  const musicalDuration = Math.min(trackDuration, (musEndFrame + 1) * (musEndWin / dsRate));

  // 3. First-order IIR low-pass filter
  function lpFilter(signal, fc) {
    const dt = 1.0 / dsRate;
    const rc = 1.0 / (2.0 * Math.PI * fc);
    const alpha = dt / (rc + dt);
    const out = new Float32Array(signal.length);
    let y = 0;
    for (let i = 0; i < signal.length; i++) {
      y += alpha * (signal[i] - y);
      out[i] = y;
    }
    return out;
  }

  // Frequency bands: kick (0-200 Hz), mid (200-2000 Hz), hi (2000+ Hz)
  const lp200  = lpFilter(ds, 200);
  const lp2000 = lpFilter(ds, 2000);
  const bandKick = lp200;
  const bandMid  = new Float32Array(nDS);
  const bandHi   = new Float32Array(nDS);
  for (let i = 0; i < nDS; i++) {
    bandMid[i] = lp2000[i] - lp200[i];
    bandHi[i]  = ds[i]    - lp2000[i];
  }

  // 4. Half-wave rectified RMS-flux onset detection function per band
  const HOP_S = 0.01; // 10 ms hop
  const WIN_S = 0.04; // 40 ms window
  const hop = Math.max(1, Math.round(HOP_S * dsRate));
  const win = Math.max(hop * 2, Math.round(WIN_S * dsRate));
  const nFrames = Math.floor((nDS - win) / hop);
  if (nFrames < 16) return 120;

  const fps = dsRate / hop; // ODF frames per second

  function computeODF(signal) {
    const odf = new Float32Array(nFrames);
    let prevRMS = 0;
    for (let i = 0; i < nFrames; i++) {
      const start = i * hop;
      let e = 0;
      for (let j = 0; j < win; j++) {
        const s = signal[start + j] || 0;
        e += s * s;
      }
      const rms = Math.sqrt(e / win);
      const diff = rms - prevRMS;
      odf[i] = diff > 0 ? diff : 0;
      prevRMS = rms;
    }
    let max = 0;
    for (let i = 0; i < nFrames; i++) if (odf[i] > max) max = odf[i];
    if (max > 0) for (let i = 0; i < nFrames; i++) odf[i] /= max;
    return odf;
  }

  const odfKick = computeODF(bandKick);
  const odfMid  = computeODF(bandMid);
  const odfHi   = computeODF(bandHi);

  // Combine: heavily weight kick drum (60%), mid (30%), hi (10%)
  const odf = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    odf[i] = 0.6 * odfKick[i] + 0.3 * odfMid[i] + 0.1 * odfHi[i];
  }

  // 5. Compute ACF over wide lag range + 8x harmonics
  const minLag = Math.max(1, Math.floor(fps * 60 / SEARCH_MAX));
  const maxLag = Math.ceil(fps * 60 / SEARCH_MIN);
  const acfMax = Math.min(8 * maxLag, nFrames - 1);

  const acf = new Float64Array(acfMax + 1);
  for (let lag = minLag; lag <= acfMax; lag++) {
    let s = 0, cnt = 0;
    for (let i = 0; i + lag < nFrames; i++) {
      s += odf[i] * odf[i + lag];
      cnt++;
    }
    acf[lag] = cnt > 0 ? s / cnt : 0;
  }

  // 6. Score each candidate tempo using harmonic sum
  // Emphasise powers-of-2 harmonics: beat (k=1), half-bar (k=2), bar (k=4), phrase (k=8)
  const hWeights = [1.0, 0.5, 0.15, 0.6, 0.1, 0.08, 0.08, 0.4];

  // 7. Bar-alignment bonus: producers always export at exact bar boundaries.
  //    Test rawBpm plus its integer neighbours (floor/ceil) to account for
  //    the quantization error introduced by integer lag values.
  //    Bar count must be a multiple of 4 (standard structural unit).
  //    Both trackDuration and musicalDuration (before reverb tail) are tested.
  function barAlignmentBonus(rawBpm) {
    const durations = [trackDuration];
    if (musicalDuration < trackDuration - 0.5) durations.push(musicalDuration);

    let best = 1.0;
    for (const dur of durations) {
      if (dur < 4) continue;
      for (const bpm of [rawBpm, Math.floor(rawBpm), Math.ceil(rawBpm)]) {
        if (bpm <= 0) continue;
        const barDur = 4 * 60 / bpm;
        const bars = dur / barDur;
        const nearest = Math.round(bars);
        if (nearest < 2) continue;
        const err = Math.abs(bars - nearest) / bars;
        let b;
        if (nearest % 4 === 0 && err < 0.005) b = 3.0;
        else if (nearest % 2 === 0 && err < 0.005) b = 1.8;
        else if (err < 0.02) b = 1.1;
        else b = 1.0;
        if (b > best) best = b;
      }
    }
    return best;
  }

  let bestScore = -1;
  let bestLag = minLag;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let acfScore = 0;
    for (let k = 1; k <= hWeights.length; k++) {
      const kLag = k * lag;
      if (kLag <= acfMax) acfScore += hWeights[k - 1] * acf[kLag];
    }
    const rawBpm = (fps * 60) / lag;
    const score = acfScore * barAlignmentBonus(rawBpm);
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }

  let bpm = Math.round((fps * 60) / bestLag);

  // 8. Fold into 80–160 BPM range
  while (bpm > MAX_FOLD) bpm = Math.round(bpm / 2);
  while (bpm < MIN_FOLD) bpm = Math.round(bpm * 2);

  return bpm;
}

// ---- Expected BPM extraction from filename (mirrors extractBpmFromFilename) ----

function extractBpmFromFilename(name) {
  const lower = name.toLowerCase();
  const explicit = lower.match(/(\d{2,3})\s*bpm/);
  if (explicit) {
    const bpm = parseInt(explicit[1], 10);
    if (bpm >= 60 && bpm <= 220) return bpm;
  }

  const numbers = lower.match(/(\d{2,3})/g);
  if (numbers) {
    const candidates = numbers
      .map((n) => parseInt(n, 10))
      .filter((n) => n >= 60 && n <= 220);
    if (candidates.length > 0) return candidates[0];
  }

  return null;
}

// ---- Main runner ----

function run() {
  const publicDir = path.join(__dirname, "..", "public");
  const allFiles = fs.readdirSync(publicDir);
  const wavFiles = allFiles.filter((f) => f.toLowerCase().endsWith(".wav"));

  const results = [];
  const mismatches = [];

  for (const file of wavFiles) {
    const fullPath = path.join(publicDir, file);
    const expected = extractBpmFromFilename(file);

    const { channelData, sampleRate } = decodeWavToMonoFloat32(fullPath);
    const detected = Math.round(detectBpmFromSignal(channelData, sampleRate));

    results.push({ file, expected, detected });

    // Treat off-by-one as OK to avoid overfitting to rounding noise.
    if (expected != null && Math.abs(detected - expected) > 1) {
      mismatches.push({ file, expected, detected });
    }
  }

  console.log("=== BPM regression results ===");
  console.table(results);

  if (mismatches.length) {
    console.log("\n=== MISMATCHES ===");
    console.table(mismatches);
    process.exitCode = 1;
  } else {
    console.log("\nAll labeled files matched expected BPM.");
  }
}

run();
