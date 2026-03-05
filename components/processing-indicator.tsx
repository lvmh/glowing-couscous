"use client";

import { useEffect, useState } from "react";

const STEPS = [
  { cmd: "decode()",  label: "reading audio buffer"      },
  { cmd: "tempo()",   label: "detecting bpm"             },
  { cmd: "key()",     label: "scanning harmonic content" },
  { cmd: "trim()",    label: "trimming silence"          },
  { cmd: "export()",  label: "preparing output"          },
];

// Each step gets a slightly different duration so it feels organic, not robotic.
// Fast enough that all 5 steps tick through even on short (< 2s) analyses.
const STEP_DURATIONS = [280, 340, 420, 240, 300];

export function ProcessingIndicator() {
  const [activeStep, setActiveStep] = useState(0);
  const [doneSteps, setDoneSteps]   = useState<Set<number>>(new Set());
  const [dots, setDots]             = useState(".");

  useEffect(() => {
    let current = 0;
    let timeout: ReturnType<typeof setTimeout>;

    const advance = () => {
      const next = (current + 1) % STEPS.length;
      setDoneSteps((prev) => new Set(prev).add(current));
      current = next;
      setActiveStep(current);
      timeout = setTimeout(advance, STEP_DURATIONS[current]);
    };

    timeout = setTimeout(advance, STEP_DURATIONS[0]);

    const dotInterval = setInterval(() => {
      setDots((p) => (p.length >= 4 ? "." : p + "."));
    }, 300);

    return () => {
      clearTimeout(timeout);
      clearInterval(dotInterval);
    };
  }, []);

  return (
    <div className="py-3 space-y-4">
      {/* header */}
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
          const isActive = i === activeStep;
          const isDone   = doneSteps.has(i) && !isActive;
          const isPending = !isActive && !isDone;
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
                isDone   ? "text-muted-foreground/50 line-through decoration-muted-foreground/20" :
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
                <span className="text-primary/40 text-[10px]">✓</span>
              )}

              {isPending && (
                <span className="text-muted-foreground/20 text-[10px]">{s.label}</span>
              )}
            </div>
          );
        })}
      </div>

      {/* footer */}
      <div className="flex items-center gap-1.5 text-[10px] text-primary/40">
        <span className="flex-1 border-t border-dashed border-border/20" />
        <span>✧</span><span>✦</span><span>✧</span>
        <span className="flex-1 border-t border-dashed border-border/20" />
      </div>
    </div>
  );
}
