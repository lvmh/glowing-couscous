"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { UploadZone } from "./upload-zone";
import { AnalysisResults } from "./analysis-results";
import { ProcessingIndicator } from "./processing-indicator";
import type { AudioAnalysis } from "@/lib/audio-engine";
import { analyzeAudio } from "@/lib/audio-engine";

type State = "idle" | "processing" | "done" | "error";

interface UploadedFileEntry {
  id: string;
  file: File;
}

export function AudioAnalyzer() {
  const [state, setState] = useState<State>("idle");
  const [analysis, setAnalysis] = useState<AudioAnalysis | null>(null);
  const [error, setError] = useState<string>("");
  const [fileName, setFileName] = useState<string>("");
  const [files, setFiles] = useState<UploadedFileEntry[]>([]);

  const stopPlaybackRef = useRef<(() => void) | null>(null);

  const analyzeFile = useCallback(async (file: File) => {
    setState("processing");
    setError("");
    setFileName(file.name);

    try {
      const result = await analyzeAudio(file);
      setAnalysis(result);
      setState("done");
    } catch (err) {
      console.error("Analysis failed:", err);
      setError(
        err instanceof Error
          ? err.message
          : "Failed to analyze audio. Please try a different file."
      );
      setState("error");
    }
  }, []);

  const handleFilesSelected = useCallback(
    async (selectedFiles: File[]) => {
      if (!selectedFiles?.length) return;
      setFiles((prev) => [
        ...selectedFiles.map((file) => ({
          id: `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
          file,
        })),
        ...prev,
      ]);
      await analyzeFile(selectedFiles[0]);
    },
    [analyzeFile]
  );

  useEffect(() => {
    const handleWindowDragOver = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    };
    const handleWindowDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      void handleFilesSelected(Array.from(e.dataTransfer.files));
    };
    window.addEventListener("dragover", handleWindowDragOver);
    window.addEventListener("drop", handleWindowDrop);
    return () => {
      window.removeEventListener("dragover", handleWindowDragOver);
      window.removeEventListener("drop", handleWindowDrop);
    };
  }, [handleFilesSelected]);

  const handleReset = useCallback(() => {
    setState("idle");
    setAnalysis(null);
    setError("");
    setFileName("");
    setFiles([]);
  }, []);

  return (
    <div className="flex flex-col gap-4">

      {/* ── loaded file header ─────────────────────────────────────── */}
      {state !== "idle" && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-primary">❯</span>
          <span className="text-muted-foreground">loaded</span>
          <span className="text-primary/40">·</span>
          <span className="truncate text-foreground">{fileName}</span>
          <button
            type="button"
            onClick={handleReset}
            className="ml-auto shrink-0 text-muted-foreground/50 hover:text-primary transition-colors"
          >
            [reset]
          </button>
        </div>
      )}

      {/* ── file queue ─────────────────────────────────────────────── */}
      {files.length > 1 && (
        <div>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground/50 mb-1.5">
            <span className="text-primary/60">·</span>
            <span>queue</span>
            <span className="flex-1 border-t border-dashed border-border/30" />
          </div>
          <div className="max-h-28 space-y-0.5 overflow-y-auto">
            {files.map((entry) => {
              const isCurrent = entry.file.name === fileName;
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => {
                    if (!isCurrent) {
                      stopPlaybackRef.current?.();
                      void analyzeFile(entry.file);
                    }
                  }}
                  className={`flex w-full items-center gap-2 px-1 py-0.5 text-xs text-left transition-colors rounded ${
                    isCurrent
                      ? "text-primary"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <span>{isCurrent ? "▸" : "·"}</span>
                  <span className="truncate">{entry.file.name}</span>
                  {isCurrent && <span className="ml-auto text-primary/60 text-[10px]">active</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── state content ──────────────────────────────────────────── */}
      {state === "idle" && (
        <UploadZone onFilesSelected={handleFilesSelected} isProcessing={false} />
      )}

      {state === "processing" && <ProcessingIndicator />}

      {state === "done" && analysis && (
        <AnalysisResults analysis={analysis} stopRef={stopPlaybackRef} />
      )}

      {state === "error" && (
        <div className="space-y-3 rounded-lg border border-destructive/40 p-4">
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground/60">
            <span className="text-destructive">✗</span>
            <span>error</span>
            <span className="flex-1 border-t border-dashed border-border/30" />
          </div>
          <p className="text-xs text-destructive pl-1">{error}</p>
          <button
            type="button"
            onClick={handleReset}
            className="text-xs text-muted-foreground hover:text-primary transition-colors pl-1"
          >
            <span className="text-primary">❯</span> try again
          </button>
        </div>
      )}
    </div>
  );
}
