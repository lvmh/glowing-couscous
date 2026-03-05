"use client";

import { useCallback, useState } from "react";
import type React from "react";

const ACCEPTED_TYPES = [
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
];

const ACCEPTED_EXTENSIONS = [".wav", ".mp3", ".m4a"];

interface UploadZoneProps {
  onFilesSelected: (files: File[]) => void;
  isProcessing: boolean;
}

export function UploadZone({ onFilesSelected, isProcessing }: UploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);

  const isValidFile = (file: File) => {
    const ext = file.name.toLowerCase().slice(file.name.lastIndexOf("."));
    return ACCEPTED_TYPES.includes(file.type) || ACCEPTED_EXTENSIONS.includes(ext);
  };

  const handleFiles = useCallback(
    (files: FileList | File[]) => {
      const validFiles = Array.from(files).filter(isValidFile);
      if (validFiles.length > 0) onFilesSelected(validFiles);
    },
    [onFilesSelected]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      if (isProcessing) return;
      if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files);
    },
    [handleFiles, isProcessing]
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!isProcessing) setIsDragging(true);
    },
    [isProcessing]
  );

  const handleDragLeave = useCallback(() => setIsDragging(false), []);

  const handleClick = useCallback(() => {
    if (isProcessing) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ACCEPTED_EXTENSIONS.join(",");
    input.multiple = true;
    input.onchange = (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (files?.length) handleFiles(files);
    };
    input.click();
  }, [handleFiles, isProcessing]);

  return (
    <div
      onClick={handleClick}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      className={`
        relative cursor-pointer select-none rounded-lg border transition-all duration-150 p-5
        ${isDragging
          ? "border-primary bg-primary/5"
          : "border-border/50 border-dashed hover:border-primary/50 hover:bg-secondary/20"
        }
        ${isProcessing ? "opacity-50 pointer-events-none" : ""}
      `}
    >
      {/* top rule */}
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground/50 mb-4">
        <span className="text-primary/70">✦</span>
        <span className="flex-1 border-t border-dashed border-border/30" />
        <span>drop zone</span>
        <span className="flex-1 border-t border-dashed border-border/30" />
        <span className="text-primary/70">✦</span>
      </div>

      <div className="space-y-1.5">
        <p className="text-sm text-foreground leading-relaxed">
          <span className="text-primary">❯</span>{" "}
          {isDragging ? (
            <>drop it! <span className="text-primary animate-pulse">✦</span></>
          ) : (
            <>
              drop your file here
              <span className="animate-blink text-primary">_</span>
            </>
          )}
        </p>
        <p className="pl-4 text-xs text-muted-foreground">
          {isDragging
            ? "✧ release to analyze ✧"
            : "for bpm & key detection · wav mp3 m4a"}
        </p>
      </div>

      {/* bottom rule */}
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground/40 mt-4">
        <span className="flex-1 border-t border-dashed border-border/20" />
        <span>click anywhere to browse</span>
        <span className="flex-1 border-t border-dashed border-border/20" />
      </div>
    </div>
  );
}
