"use client";

import { useEffect, useRef, useState } from "react";
import type React from "react";
import type { AudioAnalysis } from "@/lib/audio-engine";
import { audioBufferToWav, generateOutputFilename, NOTE_NAMES } from "@/lib/audio-engine";
import { WaveformDisplay } from "./waveform-display";

interface AnalysisResultsProps {
  analysis: AudioAnalysis;
  stopRef?: React.MutableRefObject<(() => void) | null>;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** ── thin section divider ── */
function Rule({ label, sparkle = false }: { label: string; sparkle?: boolean }) {
  return (
    <div className="flex items-center gap-2 text-[10px] text-muted-foreground/60">
      <span className={sparkle ? "text-primary" : "text-primary/60"}>
        {sparkle ? "✦" : "·"}
      </span>
      <span>{label}</span>
      <span className="flex-1 border-t border-dashed border-border/30" />
      {sparkle && <span className="text-primary/40">✧</span>}
    </div>
  );
}

export function AnalysisResults({ analysis, stopRef }: AnalysisResultsProps) {
  const silenceTrimmed = analysis.duration - analysis.trimmedDuration;

  // ── playback ─────────────────────────────────────────────────────────────────
  const audioContextRef   = useRef<AudioContext | null>(null);
  const sourceRef         = useRef<AudioBufferSourceNode | null>(null);
  const playStartTimeRef  = useRef<number | null>(null);
  const playOffsetRef     = useRef<number>(0);
  const rafRef            = useRef<number | null>(null);
  const intentionalStopRef = useRef(false);
  const [isPlaying, setIsPlaying]           = useState(false);
  const [playbackPosition, setPlaybackPosition] = useState<number | undefined>(undefined);
  const [currentTime, setCurrentTime]       = useState(0);

  // ── key override ─────────────────────────────────────────────────────────────
  const [userKeyIndex, setUserKeyIndex] = useState<number | null>(null);
  const [userMode, setUserMode]         = useState<"Major" | "Minor" | null>(null);

  useEffect(() => { setUserKeyIndex(null); setUserMode(null); }, [analysis]);

  const relativeKeyIndex  = analysis.mode === "Major" ? (analysis.keyIndex + 9) % 12 : (analysis.keyIndex + 3) % 12;
  const relativeMode: "Major" | "Minor" = analysis.mode === "Major" ? "Minor" : "Major";
  const relativeKeyName   = NOTE_NAMES[relativeKeyIndex];
  const effectiveKeyIndex = userKeyIndex ?? analysis.keyIndex;
  const effectiveMode     = userMode ?? analysis.mode;
  const effectiveKey      = NOTE_NAMES[effectiveKeyIndex];
  const isUsingRelative   = userKeyIndex === relativeKeyIndex && userMode === relativeMode;

  const outputFilename = generateOutputFilename(
    analysis.originalName, analysis.bpm, effectiveKey, effectiveMode
  );

  // ── helpers ──────────────────────────────────────────────────────────────────
  const stopRaf = () => {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
  };

  const stopCurrentSource = () => {
    if (sourceRef.current) {
      intentionalStopRef.current = true;
      try { sourceRef.current.stop(); } catch { /* already stopped */ }
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
  };

  const resetPlayState = () => {
    stopRaf();
    stopCurrentSource();
    playStartTimeRef.current = null;
    playOffsetRef.current = 0;
    setIsPlaying(false);
    setPlaybackPosition(undefined);
    setCurrentTime(0);
  };

  useEffect(() => {
    if (stopRef) stopRef.current = resetPlayState;
    return () => { if (stopRef) stopRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopRef]);

  useEffect(() => {
    return () => {
      resetPlayState();
      if (audioContextRef.current) { audioContextRef.current.close(); audioContextRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis]);

  const ensureAudioContext = async (): Promise<AudioContext> => {
    let ctx = audioContextRef.current;
    if (!ctx || ctx.state === "closed") { ctx = new AudioContext(); audioContextRef.current = ctx; }
    if (ctx.state === "suspended") await ctx.resume();
    return ctx;
  };

  const startPlaybackAt = async (offsetSeconds: number) => {
    try {
      const ctx = await ensureAudioContext();
      const clampedOffset = Math.min(Math.max(offsetSeconds, 0), analysis.trimmedDuration);
      stopCurrentSource();
      stopRaf();

      const source = ctx.createBufferSource();
      source.buffer = analysis.trimmedBuffer;
      source.connect(ctx.destination);
      source.start(0, clampedOffset);

      playOffsetRef.current   = clampedOffset;
      playStartTimeRef.current = ctx.currentTime;
      setIsPlaying(true);

      const tick = () => {
        const audioCtx = audioContextRef.current;
        if (!audioCtx || playStartTimeRef.current === null) return;
        const elapsed = audioCtx.currentTime - playStartTimeRef.current;
        const time = Math.min(playOffsetRef.current + elapsed, analysis.trimmedDuration);
        setCurrentTime(time);
        setPlaybackPosition(time / analysis.trimmedDuration);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);

      source.onended = () => {
        if (intentionalStopRef.current) { intentionalStopRef.current = false; return; }
        stopRaf();
        sourceRef.current = null;
        playStartTimeRef.current = null;
        playOffsetRef.current = 0;
        setIsPlaying(false);
        setPlaybackPosition(undefined);
        setCurrentTime(0);
      };
      sourceRef.current = source;
    } catch (err) {
      console.error("Playback failed:", err);
    }
  };

  const handleWaveformClick  = async (position: number) => startPlaybackAt(position * analysis.trimmedDuration);

  const handleTogglePlayPause = async () => {
    const ctx = audioContextRef.current;
    if (isPlaying && ctx) {
      const elapsed = playStartTimeRef.current != null ? ctx.currentTime - playStartTimeRef.current : 0;
      playOffsetRef.current = Math.min(playOffsetRef.current + elapsed, analysis.trimmedDuration);
      playStartTimeRef.current = null;
      stopRaf();
      stopCurrentSource();
      setIsPlaying(false);
      return;
    }
    await startPlaybackAt(playOffsetRef.current || 0);
  };

  const handleDownload = () => {
    const wavBlob = audioBufferToWav(analysis.trimmedBuffer);
    const url = URL.createObjectURL(wavBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = outputFilename;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── render ───────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4">

      {/* waveform */}
      <div className="flex flex-col gap-2">
        <Rule label="waveform" />
        <WaveformDisplay
          data={analysis.waveformData}
          playbackPosition={playbackPosition}
          onClick={handleWaveformClick}
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleTogglePlayPause}
            className="text-xs text-foreground hover:text-primary transition-colors"
          >
            <span className="text-primary">{isPlaying ? "⏸" : "❯"}</span>{" "}
            {isPlaying ? "pause()" : "play()"}
          </button>
          <span className="tabular-nums text-xs text-muted-foreground">
            {formatDuration(currentTime)}
            <span className="mx-1 opacity-30">/</span>
            {formatDuration(analysis.trimmedDuration)}
          </span>
        </div>
      </div>

      {/* scan results */}
      <div className="flex flex-col gap-2">
        <Rule label="scan results" sparkle />
        <div className="space-y-1.5 pl-1">
          <Row icon="⚡" label="bpm"      value={String(analysis.bpm)}                           accent />
          <Row icon="♪"  label="key"      value={`${effectiveKey} ${effectiveMode}`}              accent />
          <Row icon="◷"  label="duration" value={formatDuration(analysis.trimmedDuration)} />
          <Row icon="✂"  label="trimmed"  value={silenceTrimmed > 0.01 ? `${silenceTrimmed.toFixed(2)}s` : "none"} />
        </div>
      </div>

      {/* key toggle */}
      <div className="flex flex-col gap-2">
        <Rule label="key" />
        <div className="flex items-center gap-2 text-xs pl-1 flex-wrap">
          <span className="text-primary/60">❯</span>
          <button
            type="button"
            onClick={() => { setUserKeyIndex(null); setUserMode(null); }}
            className={`transition-colors px-1.5 py-0.5 rounded ${
              !isUsingRelative
                ? "text-primary bg-primary/10"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {!isUsingRelative && <span className="mr-1 text-[10px]">✦</span>}
            [{analysis.key} {analysis.mode}]
          </button>
          <span className="text-muted-foreground/40">↔</span>
          <button
            type="button"
            onClick={() => {
              if (isUsingRelative) { setUserKeyIndex(null); setUserMode(null); }
              else { setUserKeyIndex(relativeKeyIndex); setUserMode(relativeMode); }
            }}
            className={`transition-colors px-1.5 py-0.5 rounded ${
              isUsingRelative
                ? "text-primary bg-primary/10"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {isUsingRelative && <span className="mr-1 text-[10px]">✦</span>}
            [{relativeKeyName} {relativeMode}]
          </button>
          <span className="ml-auto text-[10px] text-muted-foreground/40 italic">~relative~</span>
        </div>
      </div>

      {/* bpm source */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground/60">
          <span className="text-primary/40">·</span>
          <span>source</span>
          <span className="text-primary/60">{analysis.bpmSource === "filename" ? "filename" : "detector"}</span>
          <span className="flex-1 border-t border-dashed border-border/30" />
        </div>
        <div className="space-y-0.5 pl-1 text-xs text-muted-foreground">
          <div className="flex gap-3">
            <span className="w-16 text-[10px]">final</span>
            <span className="text-foreground">{analysis.bpm} bpm</span>
          </div>
          {analysis.filenameBpm != null && (
            <div className="flex gap-3">
              <span className="w-16 text-[10px]">filename</span>
              <span>{analysis.filenameBpm} bpm</span>
            </div>
          )}
          <div className="flex gap-3">
            <span className="w-16 text-[10px]">detected</span>
            <span>{analysis.detectedBpm} bpm</span>
          </div>
          {analysis.filenameBpm != null && (
            <div className="flex gap-3">
              <span className="w-16 text-[10px]">delta</span>
              <span className={Math.abs(analysis.detectedBpm - analysis.filenameBpm) < 1 ? "text-primary" : ""}>
                {(analysis.detectedBpm - analysis.filenameBpm).toFixed(1)} bpm
              </span>
            </div>
          )}
        </div>
      </div>

      {/* output filename */}
      <div className="flex flex-col gap-1.5">
        <Rule label="output" sparkle />
        <p className="pl-1 text-sm text-foreground break-all">
          <span className="text-primary">❯</span>{" "}
          {outputFilename}
          <span className="animate-blink text-primary">_</span>
        </p>
      </div>

      {/* export button */}
      <button
        type="button"
        onClick={handleDownload}
        className="w-full border border-primary/30 hover:border-primary hover:bg-primary/5 text-sm py-3 px-4 transition-all group text-left rounded-lg"
      >
        <span className="text-primary group-hover:text-primary">❯</span>{" "}
        <span className="text-foreground">export(</span>
        <span className="text-primary">{outputFilename}</span>
        <span className="text-foreground">)</span>
        <span className="float-right text-primary/40 text-xs mt-0.5">✦ download wav</span>
      </button>

    </div>
  );
}

function Row({
  icon, label, value, accent = false,
}: {
  icon: string; label: string; value: string; accent?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-3 text-xs">
      <span className="text-muted-foreground/60 w-4 shrink-0">{icon}</span>
      <span className="text-muted-foreground w-14 shrink-0">{label}</span>
      <span className={accent ? "text-primary font-bold text-sm" : "text-foreground"}>{value}</span>
    </div>
  );
}
