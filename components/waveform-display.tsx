"use client";

import { useRef, useEffect } from "react";
import { useTheme } from "next-themes";
import type React from "react";

interface WaveformDisplayProps {
  data: number[];
  /** 0–1 normalised position of the playhead; undefined = not playing */
  playbackPosition?: number;
  onClick?: (position: number) => void;
}

export function WaveformDisplay({ data, playbackPosition, onClick }: WaveformDisplayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || data.length === 0) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();

    // Only resize the backing store when the logical size actually changed —
    // assigning canvas.width always clears the canvas even when unchanged.
    const targetW = Math.round(rect.width * dpr);
    const targetH = Math.round(rect.height * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const width = rect.width;
    const height = rect.height;
    const barWidth = width / data.length;
    const centerY = height / 2;

    ctx.clearRect(0, 0, width, height);

    const isDark = resolvedTheme === "dark";

    // Center line
    ctx.beginPath();
    ctx.strokeStyle = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.08)";
    ctx.lineWidth = 1;
    ctx.moveTo(0, centerY);
    ctx.lineTo(width, centerY);
    ctx.stroke();

    const hasPlayhead = playbackPosition != null && playbackPosition > 0;
    const playedX = hasPlayhead ? Math.round(playbackPosition! * width) : 0;

    const drawBars = (alpha: number) => {
      ctx.fillStyle = `rgba(0, 204, 136, ${alpha})`;
      for (let i = 0; i < data.length; i++) {
        const barHeight = data[i] * (height * 0.42);
        const x = i * barWidth;
        ctx.fillRect(x + 0.5, centerY - barHeight, Math.max(barWidth - 1, 1), barHeight);
        ctx.fillRect(x + 0.5, centerY, Math.max(barWidth - 1, 1), barHeight);
      }
    };

    if (!hasPlayhead) {
      drawBars(0.85);
    } else {
      // Unplayed region — dim
      drawBars(0.28);

      // Played region — bright, clipped
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, playedX, height);
      ctx.clip();
      drawBars(0.9);
      ctx.restore();

      // Playhead line
      ctx.strokeStyle = isDark ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.7)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playedX, 0);
      ctx.lineTo(playedX, height);
      ctx.stroke();
    }
  }, [data, playbackPosition, resolvedTheme]);

  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onClick) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    onClick(Math.min(Math.max(x / rect.width, 0), 1));
  };

  return (
    <div className="w-full rounded-lg bg-secondary/30 p-4">
      <canvas
        ref={canvasRef}
        className="h-32 w-full sm:h-40 cursor-pointer"
        style={{ display: "block" }}
        onClick={handleClick}
      />
    </div>
  );
}
