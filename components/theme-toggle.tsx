"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  const isDark = resolvedTheme === "dark";

  return (
    <button
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label="Toggle theme"
      className="font-mono text-[11px] text-muted-foreground hover:text-primary transition-colors bg-card/80 backdrop-blur-sm px-2.5 py-1.5 rounded border border-border/40 hover:border-primary/40"
    >
      {isDark ? "☀ light" : "☽ dark"}
    </button>
  );
}
