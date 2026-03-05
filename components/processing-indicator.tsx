"use client";

import { useEffect, useState } from "react";

const STEPS = [
  { cmd: "decode()",   label: "reading audio buffer"      },
  { cmd: "tempo()",    label: "detecting bpm"             },
  { cmd: "key()",      label: "scanning harmonic content" },
  { cmd: "trim()",     label: "trimming silence"          },
  { cmd: "export()",   label: "preparing output"          },
];

export function ProcessingIndicator() {
  const [step, setStep] = useState(0);
  const [dots, setDots] = useState(".");

  useEffect(() => {
    const stepInterval = setInterval(() => {
      setStep((p) => Math.min(p + 1, STEPS.length - 1));
    }, 1400);
    const dotInterval = setInterval(() => {
      setDots((p) => (p.length >= 6 ? "." : p + "."));
    }, 260);
    return () => {
      clearInterval(stepInterval);
      clearInterval(dotInterval);
    };
  }, []);

  return (
    <div className="py-3 space-y-4">
      {/* header rule */}
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground/60">
        <span className="text-primary">✦</span>
        <span>analyzing</span>
        <span className="flex-1 border-t border-dashed border-border/30" />
        <span className="text-primary animate-pulse">running</span>
        <span className="text-primary/60">✦</span>
      </div>

      {/* steps */}
      <div className="space-y-2">
        {STEPS.map((s, i) => {
          const isDone   = i < step;
          const isActive = i === step;
          const isPending = i > step;
          return (
            <div key={s.cmd} className="flex items-baseline gap-2.5 text-xs">
              <span className={
                isDone   ? "text-primary" :
                isActive ? "text-primary" :
                           "text-muted-foreground/25"
              }>
                {isDone ? "✦" : isActive ? "❯" : "·"}
              </span>

              <span className={
                isDone   ? "text-muted-foreground line-through decoration-muted-foreground/30" :
                isActive ? "text-foreground" :
                           "text-muted-foreground/25"
              }>
                {s.cmd}
              </span>

              {isActive && (
                <span className="text-muted-foreground">
                  {s.label}
                  <span className="text-primary/70">{dots}</span>
                </span>
              )}

              {isDone && (
                <span className="text-primary/50 text-[10px]">done ✓</span>
              )}

              {isPending && (
                <span className="text-muted-foreground/20 text-[10px]">{s.label}</span>
              )}
            </div>
          );
        })}
      </div>

      {/* sparkle footer */}
      <div className="flex items-center gap-1.5 text-[10px] text-primary/40">
        <span className="flex-1 border-t border-dashed border-border/20" />
        <span>✧</span>
        <span>✦</span>
        <span>✧</span>
        <span className="flex-1 border-t border-dashed border-border/20" />
      </div>
    </div>
  );
}
