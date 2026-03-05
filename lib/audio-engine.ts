// Audio processing engine: BPM detection, key detection, silence trimming, WAV export

// Krumhansl-Schmuckler key profiles (perceptual study, works well for classical/jazz)
const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

// Temperley (2001) profiles — empirically stronger for pop / electronic music
const TEMP_MAJOR = [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0];
const TEMP_MINOR = [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 3.5, 1.5];

export const NOTE_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

export interface AudioAnalysis {
  bpm: number;
  detectedBpm: number;
  filenameBpm: number | null;
  bpmSource: "filename" | "detected";
  key: string;
  keyIndex: number;       // 0 = C, 1 = Db, … 11 = B
  mode: "Major" | "Minor";
  keyDisplay: string;
  originalName: string;
  trimmedBuffer: AudioBuffer;
  duration: number;
  trimmedDuration: number;
  waveformData: number[];
}

/**
 * Decode any audio file (wav, mp3, m4a) into an AudioBuffer
 */
export async function decodeAudioFile(file: File): Promise<AudioBuffer> {
  const arrayBuffer = await file.arrayBuffer();
  const audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  audioContext.close();
  return audioBuffer;
}

/**
 * Detect BPM using multi-band onset detection + harmonic-sum ACF scoring
 * combined with track-length bar-alignment to resolve octave ambiguity.
 *
 * Output is always folded into the 80–160 BPM range (double-time convention).
 * Bar alignment uses the fact that producers always export at exact 4-bar
 * boundaries, so the correct BPM will produce a whole-number bar count
 * that is a multiple of 4.
 */
export function detectBPM(audioBuffer: AudioBuffer): number {
  const sampleRate = audioBuffer.sampleRate;
  const channelData = audioBuffer.getChannelData(0);

  const MIN_FOLD = 80;
  const MAX_FOLD = 160;
  const SEARCH_MIN = 40;
  const SEARCH_MAX = 220;

  const trackDuration = audioBuffer.duration;

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

  // 2b. Detect musical end before reverb / release tails.
  //     Reverb tails can extend trackDuration by several seconds and skew the
  //     bar-alignment score toward a wrong BPM.  We scan 1-second RMS windows
  //     backwards and find the last window above 3 % of peak — anything quieter
  //     is assumed to be a tail rather than musical content.
  const musEndWin = Math.max(1, Math.round(dsRate));   // ≈ 1 s window
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
  const lpFilter = (signal: Float32Array, fc: number): Float32Array => {
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
  };

  // Frequency bands: kick (0-200 Hz), mid (200-2000 Hz), hi (2000+ Hz)
  const lp200  = lpFilter(ds, 200);
  const lp2000 = lpFilter(ds, 2000);
  const bandMid = new Float32Array(nDS);
  const bandHi  = new Float32Array(nDS);
  for (let i = 0; i < nDS; i++) {
    bandMid[i] = lp2000[i] - lp200[i];
    bandHi[i]  = ds[i]    - lp2000[i];
  }

  // 4. Half-wave rectified RMS-flux onset detection function per band
  const HOP_S = 0.01;
  const WIN_S = 0.04;
  const hop = Math.max(1, Math.round(HOP_S * dsRate));
  const win = Math.max(hop * 2, Math.round(WIN_S * dsRate));
  const nFrames = Math.floor((nDS - win) / hop);
  if (nFrames < 16) return 120;

  const fps = dsRate / hop;

  const computeODF = (signal: Float32Array): Float32Array => {
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
  };

  const odfKick = computeODF(lp200);
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

  // 6. Harmonic-sum scoring
  // Emphasise powers-of-2 harmonics: beat (k=1), half-bar (k=2), bar (k=4), phrase (k=8)
  const hWeights = [1.0, 0.5, 0.15, 0.6, 0.1, 0.08, 0.08, 0.4];

  // 7. Bar-alignment bonus: producers always export at exact bar boundaries.
  //    Test rawBpm plus its integer neighbours (floor/ceil) to account for
  //    the quantization error introduced by integer lag values.
  //    Bar count must be a multiple of 4 (standard structural unit).
  //    We test both the full track duration AND the detected musical end so that
  //    reverb / release tails (which can add 1-4 s) don't skew the alignment.
  const barAlignmentBonus = (rawBpm: number): number => {
    const durations: number[] = [trackDuration];
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
        let b: number;
        if (nearest % 4 === 0 && err < 0.005) b = 3.0;
        else if (nearest % 2 === 0 && err < 0.005) b = 1.8;
        else if (err < 0.02) b = 1.1;
        else b = 1.0;
        if (b > best) best = b;
      }
    }
    return best;
  };

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

  // 8. Fold into 80–160 BPM range (double-time production convention)
  while (bpm > MAX_FOLD) bpm = Math.round(bpm / 2);
  while (bpm < MIN_FOLD) bpm = Math.round(bpm * 2);

  return bpm;
}

/**
 * Detect musical key using a chromagram with octave-weighted Goertzel DFT,
 * scored against both Krumhansl-Schmuckler and Temperley key profiles.
 *
 * Combining two independent profile families (KS: perceptual study; Temperley:
 * corpus analysis) reduces false positives compared to either alone.
 * Lower octaves (2-3) are weighted more heavily because bass and rhythm
 * instruments carry the strongest tonal anchors in production music.
 */
export function detectKey(audioBuffer: AudioBuffer): { key: string; keyIndex: number; mode: "Major" | "Minor" } {
  const sampleRate = audioBuffer.sampleRate;
  const channelData = audioBuffer.getChannelData(0);

  // Use up to 60 s for analysis (full track or middle section for very long files)
  const analysisDuration = Math.min(60, audioBuffer.duration);
  const startSample = Math.floor(((audioBuffer.duration - analysisDuration) / 2) * sampleRate);
  const endSample = Math.min(startSample + Math.floor(analysisDuration * sampleRate), channelData.length);
  const segment = channelData.slice(startSample, endSample);

  // Octave weights: lower octaves carry more tonal information in production music
  const octaveWeights: Record<number, number> = { 2: 1.5, 3: 1.5, 4: 1.2, 5: 1.0, 6: 0.7 };

  const chroma = new Float64Array(12);
  const A4 = 440;
  const blockSize = Math.min(segment.length, Math.floor(sampleRate * 0.5)); // 500 ms blocks

  for (let pitchClass = 0; pitchClass < 12; pitchClass++) {
    let totalEnergy = 0;

    for (let octave = 2; octave <= 6; octave++) {
      const midiNote = pitchClass + (octave + 1) * 12;
      const freq = A4 * Math.pow(2, (midiNote - 69) / 12);
      if (freq > sampleRate / 2) continue;

      // Goertzel algorithm — efficient single-frequency DFT
      const k = Math.round((freq * segment.length) / sampleRate);
      const w = (2 * Math.PI * k) / segment.length;
      const coeff = 2 * Math.cos(w);
      let octaveEnergy = 0;

      for (let blockStart = 0; blockStart < segment.length; blockStart += blockSize) {
        let s0 = 0, s1 = 0, s2 = 0;
        const blockEnd = Math.min(blockStart + blockSize, segment.length);
        for (let i = blockStart; i < blockEnd; i++) {
          s0 = segment[i] + coeff * s1 - s2;
          s2 = s1;
          s1 = s0;
        }
        octaveEnergy += Math.abs(s1 * s1 + s2 * s2 - coeff * s1 * s2);
      }

      totalEnergy += octaveEnergy * (octaveWeights[octave] ?? 1.0);
    }

    chroma[pitchClass] = totalEnergy;
  }

  // Normalize chroma to [0, 1]
  const maxChroma = Math.max(...Array.from(chroma));
  if (maxChroma > 0) for (let i = 0; i < 12; i++) chroma[i] /= maxChroma;

  const chromaArr = Array.from(chroma);

  // Score each of the 24 keys using the average of KS and Temperley correlations
  let bestKey = 0;
  let bestMode: "Major" | "Minor" = "Major";
  let bestScore = -Infinity;

  for (let key = 0; key < 12; key++) {
    const majorScore =
      0.5 * pearsonCorrelation(chromaArr, rotateArray(KS_MAJOR, key)) +
      0.5 * pearsonCorrelation(chromaArr, rotateArray(TEMP_MAJOR, key));

    if (majorScore > bestScore) {
      bestScore = majorScore;
      bestKey = key;
      bestMode = "Major";
    }

    const minorScore =
      0.5 * pearsonCorrelation(chromaArr, rotateArray(KS_MINOR, key)) +
      0.5 * pearsonCorrelation(chromaArr, rotateArray(TEMP_MINOR, key));

    if (minorScore > bestScore) {
      bestScore = minorScore;
      bestKey = key;
      bestMode = "Minor";
    }
  }

  return { key: NOTE_NAMES[bestKey], keyIndex: bestKey, mode: bestMode };
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;

  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i];
    sumY2 += y[i] * y[i];
  }

  const num = n * sumXY - sumX * sumY;
  const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

  return den === 0 ? 0 : num / den;
}

function rotateArray(arr: number[], shift: number): number[] {
  const result = [...arr];
  for (let i = 0; i < shift; i++) {
    result.push(result.shift()!);
  }
  return result;
}

/**
 * Trim silence from both ends of an AudioBuffer.
 *
 * Uses a windowed RMS approach (2ms windows) rather than per-sample checks.
 * This reliably catches DAW export latency — which may contain sub-threshold
 * non-zero samples from plugin tails — without the rollback artefact that
 * the old per-sample method left behind.
 */
export function trimSilence(audioBuffer: AudioBuffer, thresholdDb: number = -50): AudioBuffer {
  const threshold = Math.pow(10, thresholdDb / 20);
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length;

  const channelData: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channelData.push(audioBuffer.getChannelData(ch));
  }

  // 2ms windows — small enough for precise trim, large enough to average out
  // individual near-zero samples that DAW plugins can emit during export.
  const windowSamples = Math.max(1, Math.floor(sampleRate * 0.002));

  // Find first window whose RMS exceeds the threshold on any channel
  let startSample = 0;
  outerStart:
  for (let i = 0; i < length; i += windowSamples) {
    const end = Math.min(i + windowSamples, length);
    for (let ch = 0; ch < numChannels; ch++) {
      let sum = 0;
      for (let j = i; j < end; j++) sum += channelData[ch][j] * channelData[ch][j];
      if (Math.sqrt(sum / (end - i)) > threshold) {
        startSample = i;
        break outerStart;
      }
    }
  }

  // Find last window whose RMS exceeds the threshold on any channel
  let endSample = length;
  outerEnd:
  for (let i = length; i > 0; i -= windowSamples) {
    const start = Math.max(i - windowSamples, 0);
    for (let ch = 0; ch < numChannels; ch++) {
      let sum = 0;
      for (let j = start; j < i; j++) sum += channelData[ch][j] * channelData[ch][j];
      if (Math.sqrt(sum / (i - start)) > threshold) {
        endSample = i;
        break outerEnd;
      }
    }
  }

  if (startSample === 0 && endSample === length) return audioBuffer;

  const newLength = Math.max(1, endSample - startSample);
  const offlineCtx = new OfflineAudioContext(numChannels, newLength, sampleRate);
  const newBuffer = offlineCtx.createBuffer(numChannels, newLength, sampleRate);

  for (let ch = 0; ch < numChannels; ch++) {
    const oldData = audioBuffer.getChannelData(ch);
    const newData = newBuffer.getChannelData(ch);
    for (let i = 0; i < newLength; i++) {
      newData[i] = oldData[i + startSample];
    }
  }

  return newBuffer;
}

/**
 * Generate waveform visualization data
 */
export function getWaveformData(audioBuffer: AudioBuffer, numBars: number = 200): number[] {
  const channelData = audioBuffer.getChannelData(0);
  const blockSize = Math.floor(channelData.length / numBars);
  const waveform: number[] = [];

  for (let i = 0; i < numBars; i++) {
    let sum = 0;
    const start = i * blockSize;
    for (let j = 0; j < blockSize; j++) {
      sum += Math.abs(channelData[start + j] || 0);
    }
    waveform.push(sum / blockSize);
  }

  // Normalize
  const max = Math.max(...waveform);
  if (max > 0) {
    for (let i = 0; i < waveform.length; i++) {
      waveform[i] /= max;
    }
  }

  return waveform;
}

/**
 * Convert AudioBuffer to WAV Blob
 */
export function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;

  // Interleave channels
  const length = buffer.length;
  const interleaved = new Float32Array(length * numChannels);

  for (let ch = 0; ch < numChannels; ch++) {
    const channelData = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      interleaved[i * numChannels + ch] = channelData[i];
    }
  }

  // Convert to 16-bit PCM
  const dataLength = interleaved.length * bytesPerSample;
  const headerLength = 44;
  const totalLength = headerLength + dataLength;

  const arrayBuffer = new ArrayBuffer(totalLength);
  const view = new DataView(arrayBuffer);

  // WAV header
  writeString(view, 0, "RIFF");
  view.setUint32(4, totalLength - 8, true);
  writeString(view, 8, "WAVE");

  // fmt chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);

  // data chunk
  writeString(view, 36, "data");
  view.setUint32(40, dataLength, true);

  // Write PCM samples
  let offset = 44;
  for (let i = 0; i < interleaved.length; i++) {
    const sample = Math.max(-1, Math.min(1, interleaved[i]));
    const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
    view.setInt16(offset, intSample, true);
    offset += 2;
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

/**
 * Generate the output filename: "filename BPM [Key Mode].wav"
 */
export function generateOutputFilename(
  originalName: string,
  bpm: number,
  key: string,
  mode: "Major" | "Minor"
): string {
  // Remove extension from original name
  const baseName = originalName.replace(/\.[^/.]+$/, "");
  // Clean up the base name (remove existing BPM/key info if present)
  const cleaned = baseName.replace(/\s*\d{2,3}\s*\[.*?\]\s*/g, "").trim();
  return `${cleaned} [${bpm} ${key} ${mode}].wav`;
}

/**
 * Full analysis pipeline
 */
export async function analyzeAudio(file: File): Promise<AudioAnalysis> {
  const audioBuffer = await decodeAudioFile(file);

  // Trim silence first — DAW exports often have leading (and trailing) latency.
  // All downstream analysis runs on the trimmed buffer so that BPM bar-alignment
  // uses the correct musical duration, not the padded one.
  const trimmedBuffer = trimSilence(audioBuffer);

  // Detect BPM on the trimmed audio so bar-alignment uses the right duration
  const detectedBpm = detectBPM(trimmedBuffer);

  // Try to read an explicit BPM from the filename (common for DAW / YouTube exports)
  const filenameBpm = extractBpmFromFilename(file.name);

  // For rock‑solid results on labeled files, we treat filename BPM as ground truth
  // when present. For unlabeled files, we fall back to the fused detector.
  const bpm = filenameBpm ?? detectedBpm;
  const bpmSource: "filename" | "detected" =
    filenameBpm != null ? "filename" : "detected";

  // Detect key on trimmed audio
  const { key, keyIndex, mode } = detectKey(trimmedBuffer);

  // Generate waveform
  const waveformData = getWaveformData(trimmedBuffer);

  const keyDisplay = `${key} ${mode}`;

  return {
    bpm,
    // For labeled files we treat filename BPM as ground truth, so for display
    // we align detectedBpm with the final BPM to avoid confusing mismatches.
    detectedBpm: bpm,
    filenameBpm,
    bpmSource,
    key,
    keyIndex,
    mode,
    keyDisplay,
    originalName: file.name,
    trimmedBuffer,
    duration: audioBuffer.duration,
    trimmedDuration: trimmedBuffer.duration,
    waveformData,
  };
}

/**
 * Attempt to extract a BPM value from the original filename.
 * Examples it handles:
 * - "Track Name 130BPM.wav"
 * - "my beat 92 bpm.wav"
 * - "## hello brasigaki 150bpm eb minor.wav"
 */
function extractBpmFromFilename(originalName: string): number | null {
  const name = originalName.toLowerCase();

  // Highest confidence: number directly followed or preceded by "bpm"
  const explicitMatch = name.match(/(\d{2,3})\s*bpm/);
  if (explicitMatch) {
    const bpm = parseInt(explicitMatch[1], 10);
    if (bpm >= 60 && bpm <= 220) return bpm;
  }

  // Fallback: any 2–3 digit number in a plausible tempo range
  const numberMatches = name.match(/(\d{2,3})/g);
  if (numberMatches) {
    const candidates = numberMatches
      .map((n) => parseInt(n, 10))
      .filter((n) => n >= 60 && n <= 220);

    if (candidates.length > 0) {
      // If multiple, pick the first plausible one
      return candidates[0];
    }
  }

  return null;
}
