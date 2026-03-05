// Audio processing engine: BPM detection, key detection, silence trimming, WAV export

// Krumhansl-Schmuckler key profiles (perceptual study, works well for classical/jazz)
const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

// Temperley (2001) profiles — empirically stronger for pop / electronic music
const TEMP_MAJOR = [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0];
const TEMP_MINOR = [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 3.5, 1.5];

// Mode profiles — 12 chroma weights relative to root (index 0).
// Non-diatonic notes get 0.80; characteristic color tones are boosted
// so adjacent modes can be distinguished when that degree is prominent.
//   index: 0=root 1=b2 2=2 3=b3 4=3 5=4 6=#4/b5 7=5 8=b6 9=6 10=b7 11=7
const DORIAN_PROFILE         = [6.35, 0.80, 3.00, 4.00, 0.80, 3.80, 0.80, 5.19, 0.80, 3.80, 3.40, 0.80];
const PHRYGIAN_PROFILE       = [6.35, 3.20, 0.80, 4.00, 0.80, 3.80, 0.80, 5.19, 2.80, 0.80, 3.40, 0.80];
const LYDIAN_PROFILE         = [6.35, 0.80, 3.00, 0.80, 4.38, 0.80, 3.50, 5.19, 0.80, 3.60, 0.80, 2.80];
const MIXOLYDIAN_PROFILE     = [6.35, 0.80, 3.00, 0.80, 4.38, 3.80, 0.80, 5.19, 0.80, 3.60, 3.60, 0.80];
const HARMONIC_MINOR_PROFILE = [6.35, 0.80, 3.00, 4.00, 0.80, 3.80, 0.80, 5.19, 2.80, 0.80, 0.80, 4.20];
const MELODIC_MINOR_PROFILE  = [6.35, 0.80, 3.00, 4.00, 0.80, 3.80, 0.80, 5.19, 0.80, 3.60, 0.80, 3.20];

export type ScaleMode =
  | "Major"
  | "Minor"
  | "Dorian"
  | "Phrygian"
  | "Lydian"
  | "Mixolydian"
  | "Harmonic Minor"
  | "Melodic Minor";

export const NOTE_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

export interface AudioAnalysis {
  bpm: number;
  detectedBpm: number;
  filenameBpm: number | null;
  bpmSource: "filename" | "detected";
  key: string;
  keyIndex: number;       // 0 = C, 1 = Db, … 11 = B
  mode: ScaleMode;
  keyDisplay: string;
  originalName: string;
  trimmedBuffer: AudioBuffer;
  duration: number;
  trimmedDuration: number;
  waveformData: number[];
  dcOffset: number;       // max absolute DC offset found before correction (0–1 scale)
  dcCorrected: boolean;   // whether correction was applied
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

// ─────────────────────────────────────────────────────────────────────────────
// Key detection — pro-grade pipeline
//
// Stage 1  Global tuning estimation    corrects ±30-cent detuning before
//                                       mapping frequencies to pitch classes
// Stage 2  Sliding-window analysis     5 s windows, 2.5 s hop, so drops and
//                                       choruses each get their own vote
// Stage 3  Per-window chromagram       FFT chroma (bass-biased octave weights)
//           (dual chroma)              + HPCP (spectral-peak harmonic expansion)
//                                       Both use the tuning-corrected pitch grid
// Stage 4  Spectral flatness gating    frames with low tonal content (noisy /
//           (simplified HPS)           percussive) are down-weighted before
//                                       contributing to the chromagram
// Stage 5  Four-method ensemble        per window, 24 key candidates scored:
//           A  KS + Temperley on FFT   Krumhansl–Schmuckler + Temperley
//           B  KS + Temperley on HPCP  profile correlation (Pearson)
//           C  Tonnetz on FFT          tonal-centroid Euclidean distance
//           D  Tonnetz on HPCP         (Harte et al., 2006)
// Stage 6  Energy-weighted histogram   each window's vote is weighted by its
//                                       RMS energy^1.5 — drops / choruses win
// Stage 7  Circle-of-fifths smoothing  stabilises the aggregate: adjacent keys
//                                       on the CoF share a small probability
//                                       mass, preventing implausible jumps
// Stage 8  Modal check                 upgrades to a church mode only when the
//                                       evidence clearly exceeds Major/Minor
// ─────────────────────────────────────────────────────────────────────────────

// ── Stage 1: Global tuning estimation ────────────────────────────────────────
/**
 * Estimate how many semitones the track deviates from A=440 Hz (e.g. +0.15
 * means 15 cents sharp).  Detects spectral peaks in the first 10 s, computes
 * each peak's fractional deviation from the nearest equal-tempered pitch, and
 * returns the median — robust to outlier peaks from percussion.
 */
function estimateTuning(channelData: Float32Array, sampleRate: number, frameSize: number): number {
  const HALF    = frameSize >> 1;
  const hann    = new Float64Array(frameSize);
  for (let i = 0; i < frameSize; i++) hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (frameSize - 1)));

  const re  = new Float64Array(frameSize);
  const im  = new Float64Array(frameSize);
  const deviations: number[] = [];
  const maxSamples = Math.min(channelData.length, sampleRate * 10);
  const hop = frameSize >> 1;

  for (let start = 0; start + frameSize <= maxSamples; start += hop) {
    for (let i = 0; i < frameSize; i++) { re[i] = channelData[start + i] * hann[i]; im[i] = 0; }
    fftInPlace(re, im);

    let maxMag = 0;
    const mag = new Float32Array(HALF);
    for (let b = 1; b < HALF; b++) {
      mag[b] = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
      if (mag[b] > maxMag) maxMag = mag[b];
    }
    if (maxMag === 0) continue;
    const thresh = maxMag * 0.1;

    for (let b = 2; b < HALF - 1; b++) {
      const freq = b * sampleRate / frameSize;
      if (freq < 200 || freq > 4000) continue; // mid-range only, avoids bass pitch ambiguity
      if (mag[b] <= thresh || mag[b] < mag[b - 1] || mag[b] < mag[b + 1]) continue;
      // Parabolic sub-bin refinement
      const α = mag[b - 1], β = mag[b], γ = mag[b + 1];
      const δ = 0.5 * (α - γ) / (α - 2 * β + γ + 1e-10);
      const refinedFreq = (b + δ) * sampleRate / frameSize;
      const midiFloat   = 69 + 12 * Math.log2(refinedFreq / 440);
      deviations.push(midiFloat - Math.round(midiFloat)); // range [−0.5, +0.5]
    }
  }
  if (deviations.length === 0) return 0;
  deviations.sort((a, b) => a - b);
  return deviations[Math.floor(deviations.length / 2)]; // median
}

// ── Stages 3, 4, 6: Energy-weighted chromagram with flatness gating ──────────
/**
 * Build FFT chroma and HPCP over the analysis region.
 *
 * Each FFT frame's contribution is scaled by two weights:
 *
 *   tonalWeight  — spectral flatness gate (1 = fully tonal, 0 = noisy/percussive).
 *                  Suppresses drum hits, broadband noise, and breakdowns.
 *                  Acts as a simplified harmonic–percussive separation.
 *
 *   energyWeight — frame RMS (linear, not squared), so high-energy sections
 *                  (drops, choruses) contribute proportionally more without
 *                  over-amplifying any single loud window.
 *
 * Returns both chromagrams normalised to [0, 1] plus the mean weighted energy
 * (used by the caller for optional per-section debugging).
 */
function buildChromagrams(
  channelData:  Float32Array,
  sampleRate:   number,
  startSample:  number,
  endSample:    number,
  tuningOffset: number,
  prealloc: {
    re: Float64Array; im: Float64Array; mag: Float32Array;
    binPc: Int8Array; binOct: Int8Array; hann: Float64Array;
    FRAME: number;
  }
): { fftChroma: number[]; hpcpChroma: number[] } {
  const { re, im, mag, binPc, binOct, hann, FRAME } = prealloc;
  const HOP  = FRAME >> 1;
  const HALF = FRAME >> 1;

  const fftAcc  = new Float64Array(12);
  const hpcpAcc = new Float64Array(12);
  let weightSum = 0;
  const N_HARM = 8, SIGMA2 = 1.0;

  for (let fs = startSample; fs + FRAME <= endSample; fs += HOP) {
    for (let i = 0; i < FRAME; i++) { re[i] = channelData[fs + i] * hann[i]; im[i] = 0; }
    fftInPlace(re, im);

    let maxMag = 0, sumEnergy = 0;
    for (let b = 1; b < HALF; b++) {
      mag[b] = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
      if (mag[b] > maxMag) maxMag = mag[b];
      sumEnergy += re[b] * re[b] + im[b] * im[b];
    }
    if (maxMag === 0) continue;
    const frameRMS = Math.sqrt(sumEnergy / HALF);

    // Spectral flatness: geometric_mean / arithmetic_mean ∈ [0,1].
    // Tonal content has low flatness; percussion / noise has high flatness.
    let sumLog = 0, sumLin = 0, nBins = 0;
    for (let b = 1; b < HALF; b++) {
      if (mag[b] > 0) { sumLog += Math.log(mag[b]); sumLin += mag[b]; nBins++; }
    }
    const flatness    = nBins > 0 && sumLin > 0 ? Math.exp(sumLog / nBins) / (sumLin / nBins) : 1;
    const tonalWeight = Math.max(0, 1 - 2 * flatness); // 0 = percussive, 1 = tonal

    // Combined frame weight: tonal gate × RMS energy
    const frameWeight = tonalWeight * frameRMS;
    if (frameWeight === 0) continue;

    // ── FFT chroma ────────────────────────────────────────────────────────────
    const fc = new Float64Array(12);
    for (let b = 1; b < HALF; b++) {
      const pc  = binPc[b];  if (pc < 0) continue;
      const oct = binOct[b];
      const w = oct === 2 ? 2.0 : oct === 3 ? 1.8 : oct === 4 ? 1.4 : oct === 5 ? 1.0 : 0.6;
      fc[pc] += (re[b] * re[b] + im[b] * im[b]) * w;
    }

    // ── HPCP ─────────────────────────────────────────────────────────────────
    const hc = new Float64Array(12);
    const thresh = maxMag * 0.05;
    for (let b = 2; b < HALF - 1; b++) {
      const freq = b * sampleRate / FRAME;
      if (freq < 40 || freq > 4200) continue;
      if (mag[b] <= thresh || mag[b] < mag[b - 1] || mag[b] < mag[b + 1]) continue;
      const α = mag[b - 1], β = mag[b], γ = mag[b + 1];
      const δ = 0.5 * (α - γ) / (α - 2 * β + γ + 1e-10);
      const rMidi = 69 + 12 * Math.log2(freq * (1 + δ / b) / 440) - tuningOffset;
      for (let h = 1; h <= N_HARM; h++) {
        const hm = rMidi + 12 * Math.log2(h);
        if (hm < 21 || hm > 108) continue;
        const hw = (mag[b] * mag[b]) / (h * h);
        const fp = ((hm % 12) + 12) % 12;
        for (let pc = 0; pc < 12; pc++) {
          let d = Math.abs(fp - pc);
          if (d > 6) d = 12 - d;
          hc[pc] += hw * Math.exp(-(d * d) / SIGMA2);
        }
      }
    }

    // Normalise this frame, then accumulate with combined weight
    const fm = Math.max(...Array.from(fc));
    const hm = Math.max(...Array.from(hc));
    if (fm > 0) for (let i = 0; i < 12; i++) fftAcc[i]  += (fc[i] / fm) * frameWeight;
    if (hm > 0) for (let i = 0; i < 12; i++) hpcpAcc[i] += (hc[i] / hm) * frameWeight;
    weightSum += frameWeight;
  }

  if (weightSum === 0) return { fftChroma: Array(12).fill(1 / 12), hpcpChroma: Array(12).fill(1 / 12) };

  const fftChroma  = Array.from(fftAcc).map(v => v / weightSum);
  const hpcpChroma = Array.from(hpcpAcc).map(v => v / weightSum);
  const mF = Math.max(...fftChroma);  if (mF > 0) for (let i = 0; i < 12; i++) fftChroma[i]  /= mF;
  const mH = Math.max(...hpcpChroma); if (mH > 0) for (let i = 0; i < 12; i++) hpcpChroma[i] /= mH;
  return { fftChroma, hpcpChroma };
}

// ── Stage 5A/B: KS + Temperley profile correlation ───────────────────────────
/**
 * Score all 24 key candidates using Krumhansl–Schmuckler + Temperley profiles.
 * Returns Float64Array[24]: indices 0–11 = Major keys, 12–23 = Minor keys.
 */
function ksTemperleyScores(chroma: number[]): Float64Array {
  const scores = new Float64Array(24);
  for (let key = 0; key < 12; key++) {
    scores[key]      = 0.5 * pearsonCorrelation(chroma, rotateArray(KS_MAJOR,   key))
                     + 0.5 * pearsonCorrelation(chroma, rotateArray(TEMP_MAJOR, key));
    scores[key + 12] = 0.5 * pearsonCorrelation(chroma, rotateArray(KS_MINOR,   key))
                     + 0.5 * pearsonCorrelation(chroma, rotateArray(TEMP_MINOR, key));
  }
  return scores;
}

// ── Stage 5C/D: Tonnetz tonal-centroid distance ───────────────────────────────
/**
 * Compute the 6-dimensional Tonnetz tonal centroid for a chroma vector.
 * Following Harte et al. (2006) "Detecting Harmonic Change in Musical Audio".
 *
 * The three circle frequencies represent:
 *   φ1 = cycle of fifths  (most musically salient)
 *   φ2 = minor thirds
 *   φ3 = major thirds
 */
function tonnetzCentroid(chroma: number[]): number[] {
  const PHI1 = 2 * Math.PI * 7 / 12;   // perfect fifth
  const PHI2 = 2 * Math.PI * 3 / 12;   // minor third
  const PHI3 = 2 * Math.PI * 4 / 12;   // major third
  const r = [1.0, 1.0, 0.5];           // Harte weights

  let total = 0;
  for (let p = 0; p < 12; p++) total += chroma[p];
  if (total === 0) return [0, 0, 0, 0, 0, 0];

  const T = [0, 0, 0, 0, 0, 0];
  for (let p = 0; p < 12; p++) {
    const c = chroma[p] / total;
    T[0] += c * r[0] * Math.sin(p * PHI1);
    T[1] += c * r[0] * Math.cos(p * PHI1);
    T[2] += c * r[1] * Math.sin(p * PHI2);
    T[3] += c * r[1] * Math.cos(p * PHI2);
    T[4] += c * r[2] * Math.sin(p * PHI3);
    T[5] += c * r[2] * Math.cos(p * PHI3);
  }
  return T;
}

// Cache of 24 theoretical key tonal centroids (computed once, reused).
// Indices 0–11 = Major, 12–23 = Minor.
let _tonnetzKeyCache: number[][] | null = null;

function tonnetzKeyVectors(): number[][] {
  if (_tonnetzKeyCache) return _tonnetzKeyCache;
  const majorIntervals = [0, 2, 4, 5, 7, 9, 11];
  const minorIntervals = [0, 2, 3, 5, 7, 8, 10];
  _tonnetzKeyCache = [];
  for (let root = 0; root < 12; root++) {
    const chroma = new Array(12).fill(0);
    for (const iv of majorIntervals) chroma[(root + iv) % 12] = 1;
    _tonnetzKeyCache.push(tonnetzCentroid(chroma));
  }
  for (let root = 0; root < 12; root++) {
    const chroma = new Array(12).fill(0);
    for (const iv of minorIntervals) chroma[(root + iv) % 12] = 1;
    _tonnetzKeyCache.push(tonnetzCentroid(chroma));
  }
  return _tonnetzKeyCache;
}

/**
 * Score all 24 key candidates by Euclidean distance in Tonnetz space.
 * Returns Float64Array[24] with higher = closer (better match).
 */
function tonnetzScores(chroma: number[]): Float64Array {
  const keyVecs = tonnetzKeyVectors();
  const audio   = tonnetzCentroid(chroma);
  const scores  = new Float64Array(24);
  for (let i = 0; i < 24; i++) {
    let dist = 0;
    for (let d = 0; d < 6; d++) {
      const diff = audio[d] - keyVecs[i][d];
      dist += diff * diff;
    }
    scores[i] = 1 / (1 + Math.sqrt(dist)); // higher = better
  }
  return scores;
}

// ── Stage 7: Circle-of-fifths smoothing ──────────────────────────────────────
// Maps each pitch class to its position on the circle of fifths.
// C=0, G=1, D=2, A=3, E=4, B=5, F#=6, Db=7, Ab=8, Eb=9, Bb=10, F=11
const COF_POS = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];

/** Distance in CoF steps between two of the 24 keys (0–11 major, 12–23 minor). */
function cofDist(i: number, j: number): number {
  const iMaj = i < 12, jMaj = j < 12;
  const iRoot = i % 12, jRoot = j % 12;
  // For minor keys, project to relative-major CoF position
  const iPos = iMaj ? COF_POS[iRoot] : COF_POS[(iRoot + 3) % 12];
  const jPos = iMaj ? COF_POS[jRoot] : COF_POS[(jRoot + 3) % 12];
  let d = Math.abs(iPos - jPos);
  if (d > 6) d = 12 - d;
  // Relative major/minor pairs share a CoF position; parallel pairs are 3 apart
  if (iPos === jPos && iMaj !== jMaj) return 0.5; // relative pair
  return d + (iMaj !== jMaj ? 0.5 : 0);           // cross-mode small penalty
}

/**
 * Apply Gaussian smoothing in circle-of-fifths space.
 * Stabilises temporal predictions: keys close on the CoF share probability mass.
 * σ=1.0 — tight enough to preserve major/minor distinction.
 */
function cofSmoothing(scores: Float64Array): Float64Array {
  const SIGMA2 = 1.0;
  const out = new Float64Array(24);
  for (let i = 0; i < 24; i++) {
    let sum = 0, wSum = 0;
    for (let j = 0; j < 24; j++) {
      const w = Math.exp(-(cofDist(i, j) ** 2) / (2 * SIGMA2));
      sum += scores[j] * w;
      wSum += w;
    }
    out[i] = wSum > 0 ? sum / wSum : 0;
  }
  return out;
}

// ── Full pipeline ─────────────────────────────────────────────────────────────
export function detectKey(audioBuffer: AudioBuffer): { key: string; keyIndex: number; mode: ScaleMode } {
  const sampleRate  = audioBuffer.sampleRate;
  const channelData = audioBuffer.getChannelData(0);

  // ── Stage 1: Global tuning estimation ──────────────────────────────────────
  // Use a 4096-sample window for tuning (smaller = faster, resolution still fine
  // for 200–4000 Hz range: 44100/4096 ≈ 10.8 Hz/bin → ±0.06 semi error max).
  const TUNE_FRAME  = 4096;
  const tuningOffset = estimateTuning(channelData, sampleRate, TUNE_FRAME);

  // ── Pre-allocate buffers for all window processing ──────────────────────────
  const FRAME = sampleRate >= 32000 ? 16384 : 8192;
  const HALF  = FRAME >> 1;

  const hann = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (FRAME - 1)));

  // Tuning-corrected bin → pitch class / octave lookup
  const binPc  = new Int8Array(HALF).fill(-1);
  const binOct = new Int8Array(HALF).fill(-1);
  for (let b = 1; b < HALF; b++) {
    const freq = b * sampleRate / FRAME;
    if (freq < 27.5 || freq > 4200) continue;
    const midi = 69 + 12 * Math.log2(freq / 440) - tuningOffset;
    binPc[b]  = ((Math.round(midi) % 12) + 12) % 12;
    binOct[b] = Math.floor(midi / 12) - 1;
  }

  const prealloc = {
    re: new Float64Array(FRAME), im: new Float64Array(FRAME),
    mag: new Float32Array(HALF),
    binPc, binOct, hann, FRAME,
  };

  // ── Stages 2–6: Single-pass energy+flatness-weighted chroma accumulation ────
  // Build both chromagrams over up to 60 s centred on the track. Each FFT frame
  // is weighted by (tonal_flatness_gate × frame_RMS) so that high-energy, tonal
  // sections (drops, choruses) dominate the aggregate without requiring separate
  // per-window voting — which previously caused Eb/Gb confusion.
  const analysisDuration = Math.min(60, audioBuffer.duration);
  const analysisStart    = Math.floor(((audioBuffer.duration - analysisDuration) / 2) * sampleRate);
  const analysisEnd      = Math.min(analysisStart + Math.floor(analysisDuration * sampleRate), channelData.length);

  const { fftChroma, hpcpChroma } = buildChromagrams(
    channelData, sampleRate, analysisStart, analysisEnd, tuningOffset, prealloc
  );

  // ── Stage 5: Four-method ensemble ──────────────────────────────────────────
  const methods: [Float64Array, number][] = [
    [ksTemperleyScores(fftChroma),  0.30],
    [ksTemperleyScores(hpcpChroma), 0.30],
    [tonnetzScores(fftChroma),      0.20],
    [tonnetzScores(hpcpChroma),     0.20],
  ];
  const aggregate = new Float64Array(24);
  for (const [scores, weight] of methods) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 24; i++) { if (scores[i] < lo) lo = scores[i]; if (scores[i] > hi) hi = scores[i]; }
    const range = hi - lo || 1;
    for (let i = 0; i < 24; i++) aggregate[i] += weight * (scores[i] - lo) / range;
  }

  // ── Stage 7: Circle-of-fifths smoothing ────────────────────────────────────
  const smoothed = cofSmoothing(aggregate);

  // ── Stage 8: Pick best Major / Minor, then modal check ─────────────────────
  let bestMajMinScore = -Infinity, bestMajMinKey = 0;
  let bestMajMinMode: ScaleMode = "Major";
  for (let key = 0; key < 12; key++) {
    if (smoothed[key]      > bestMajMinScore) { bestMajMinScore = smoothed[key];      bestMajMinKey = key; bestMajMinMode = "Major"; }
    if (smoothed[key + 12] > bestMajMinScore) { bestMajMinScore = smoothed[key + 12]; bestMajMinKey = key; bestMajMinMode = "Minor"; }
  }

  // Modal check: upgrade to church mode only when evidence clearly exceeds Major/Minor.
  // Use the energy-weighted fftChroma (already normalised) as the representative chroma.
  const MODAL_THRESHOLD = 0.12;
  const modalProfiles: [number[], ScaleMode][] = [
    [DORIAN_PROFILE,         "Dorian"],
    [PHRYGIAN_PROFILE,       "Phrygian"],
    [LYDIAN_PROFILE,         "Lydian"],
    [MIXOLYDIAN_PROFILE,     "Mixolydian"],
    [HARMONIC_MINOR_PROFILE, "Harmonic Minor"],
    [MELODIC_MINOR_PROFILE,  "Melodic Minor"],
  ];
  let bestModalScore = -Infinity, bestModalKey = 0, bestModalMode: ScaleMode = "Dorian";
  for (let key = 0; key < 12; key++) {
    for (const [profile, mode] of modalProfiles) {
      const score = pearsonCorrelation(fftChroma, rotateArray(profile, key));
      if (score > bestModalScore) { bestModalScore = score; bestModalKey = key; bestModalMode = mode; }
    }
  }
  if (bestModalScore > bestMajMinScore + MODAL_THRESHOLD) {
    return { key: NOTE_NAMES[bestModalKey], keyIndex: bestModalKey, mode: bestModalMode };
  }

  return { key: NOTE_NAMES[bestMajMinKey], keyIndex: bestMajMinKey, mode: bestMajMinMode };
}

/**
 * In-place radix-2 Cooley-Tukey FFT.
 * re / im must be Float64Arrays of length 2^n.
 */
function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k], uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k]           = uRe + vRe;  im[i + k]           = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;  im[i + k + len / 2] = uIm - vIm;
        const nr = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nr;
      }
    }
  }
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i]; sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i];
    sumY2 += y[i] * y[i];
  }
  const num = n * sumXY - sumX * sumY;
  const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  return den === 0 ? 0 : num / den;
}

// Right-rotation: rotateArray(arr, k)[k] === arr[0]
// Places the root weight (arr[0]) at pitch-class index k, so Pearson
// correlation correctly rewards the profile root aligning with key k.
function rotateArray(arr: number[], shift: number): number[] {
  const result = [...arr];
  for (let i = 0; i < shift; i++) result.unshift(result.pop()!);
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
 * Remove DC offset from an AudioBuffer.
 *
 * DC offset is a constant bias in the waveform — the signal's average value
 * is not zero. It's introduced by cheap audio interfaces, certain plugins, or
 * DAW export paths, and causes:
 *   • Clicks / pops at the start and end of the file
 *   • Reduced effective headroom (the signal never centres at 0)
 *   • Incorrect behaviour in downstream compressors and limiters
 *
 * Fix: compute the arithmetic mean (DC component) of each channel and subtract
 * it from every sample. Only a new buffer is written when the offset exceeds
 * a 0.01 % threshold — clean files pass through unchanged.
 */
export function removeDCOffset(
  audioBuffer: AudioBuffer
): { buffer: AudioBuffer; maxOffset: number; corrected: boolean } {
  const numChannels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const sampleRate = audioBuffer.sampleRate;

  // Measure mean (DC component) per channel
  let maxOffset = 0;
  const means: number[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    let sum = 0;
    for (let i = 0; i < length; i++) sum += data[i];
    const mean = sum / length;
    means.push(mean);
    if (Math.abs(mean) > maxOffset) maxOffset = Math.abs(mean);
  }

  // Threshold: 0.0001 = 0.01 % of full scale — below this is inaudible
  if (maxOffset < 0.0001) {
    return { buffer: audioBuffer, maxOffset, corrected: false };
  }

  // Build a new buffer with the DC component subtracted
  const offlineCtx = new OfflineAudioContext(numChannels, length, sampleRate);
  const newBuffer = offlineCtx.createBuffer(numChannels, length, sampleRate);

  for (let ch = 0; ch < numChannels; ch++) {
    const src = audioBuffer.getChannelData(ch);
    const dst = newBuffer.getChannelData(ch);
    const mean = means[ch];
    for (let i = 0; i < length; i++) dst[i] = src[i] - mean;
  }

  return { buffer: newBuffer, maxOffset, corrected: true };
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
  mode: ScaleMode
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

  // 1. Trim silence — DAW exports often have leading (and trailing) latency.
  const trimmedBuffer = trimSilence(audioBuffer);

  // 2. Remove DC offset — must happen before BPM/key analysis and before export
  //    so that the downloaded WAV is clean.
  const { buffer: cleanBuffer, maxOffset: dcOffset, corrected: dcCorrected } =
    removeDCOffset(trimmedBuffer);

  // Detect BPM on the cleaned audio
  const detectedBpm = detectBPM(cleanBuffer);

  // Try to read an explicit BPM from the filename (common for DAW / YouTube exports)
  const filenameBpm = extractBpmFromFilename(file.name);

  // For rock‑solid results on labeled files, we treat filename BPM as ground truth
  // when present. For unlabeled files, we fall back to the fused detector.
  const bpm = filenameBpm ?? detectedBpm;
  const bpmSource: "filename" | "detected" =
    filenameBpm != null ? "filename" : "detected";

  // Detect key on clean audio
  const { key, keyIndex, mode } = detectKey(cleanBuffer);

  // Generate waveform from clean audio
  const waveformData = getWaveformData(cleanBuffer);

  const keyDisplay = `${key} ${mode}`;

  return {
    bpm,
    detectedBpm: bpm,
    filenameBpm,
    bpmSource,
    key,
    keyIndex,
    mode,
    keyDisplay,
    originalName: file.name,
    trimmedBuffer: cleanBuffer,
    duration: audioBuffer.duration,
    trimmedDuration: cleanBuffer.duration,
    waveformData,
    dcOffset,
    dcCorrected,
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
