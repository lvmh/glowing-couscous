import Image from "next/image";
import { AudioAnalyzer } from "@/components/audio-analyzer";
import { ThemeToggle } from "@/components/theme-toggle";

// Figma canvas: 1091 × 1143 px
// Motorcycle:   left 36,  top 0,   width 790, height 590
// Card panel:   left 197, top 351, width 468
//
// As % of canvas width (1091):
//   moto → left 3.3%,  width 72.4%
//   card → left 18.1%, max-width 468 px
//
// Card overlaps motorcycle by 590 − 351 = 239 px = 40.5% of moto height

const MOTO_SRC =
  "/kawasaki-ninja-400-kawasaki-motorcycles-kawasaki-ninja-300-yamaha-yzf-r3-motorcycle-ee6af714ef7b226c04109372b12e20b9 1.png";

export default function Home() {
  return (
    <main className="min-h-screen bg-background">

      {/* ── Theme toggle ─────────────────────────────────────────── */}
      <div className="fixed right-4 top-4 z-50">
        <ThemeToggle />
      </div>

      {/* ── Motorcycle hero ───────────────────────────────────────── */}
      {/* Figma original: left 36px, width 790px, height 590px.
          Stays at 790 × 590 unless the viewport is narrower — then
          it scales down proportionally (aspect ratio 790:590 = 1.339). */}
      <div
        className="relative w-full overflow-hidden bg-white dark:bg-white/[0.07]"
        style={{ height: "min(590px, calc((100vw - 36px) * 0.747))" }}
      >
        <div
          className="absolute top-0 h-full"
          style={{ left: 36, width: "min(790px, calc(100vw - 36px))" }}
        >
          <Image
            src={MOTO_SRC}
            alt="Kawasaki Ninja motorcycle"
            fill
            className="object-cover object-left-top"
            priority
            sizes="(max-width: 826px) calc(100vw - 36px), 790px"
            quality={85}
          />
        </div>
        <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-background to-transparent" />
      </div>

      {/* ── App card ──────────────────────────────────────────────── */}
      {/* Fixed at Figma pixel values; shrinks proportionally on small screens */}
      <div
        className="relative z-10 pb-16"
        style={{
          marginLeft: "min(197px, 18.1vw)",
          maxWidth: 468,
          marginTop: "calc(-1 * min(239px, calc((100vw - 36px) * 0.302)))",
        }}
      >
        <div className="rounded-2xl bg-card shadow-[0_8px_48px_rgba(0,0,0,0.3)] ring-1 ring-black/[0.06] dark:ring-white/[0.06] overflow-hidden">

          {/* Terminal title bar */}
          <div className="flex items-center gap-2 border-b border-border/40 px-4 py-2.5 bg-secondary/40">
            <span className="text-xs text-primary">✦</span>
            <span className="text-xs text-foreground font-semibold tracking-wide">hotelsoap<span className="text-primary">*</span></span>
            <span className="text-xs text-muted-foreground/60">·</span>
            <span className="text-xs text-muted-foreground/60">bpm &amp; key</span>
            <span className="ml-auto text-[10px] text-primary/60 tracking-widest">✧ ✦ ✧</span>
          </div>

          <div className="p-5">
            {/* SEO-only content — visually hidden but indexed */}
            <div className="sr-only">
              <h1>hotelsoap* — Free BPM Detector &amp; Musical Key Finder Online</h1>
              <h2>Free Online BPM Detection and Key Detection Tool</h2>
              <p>
                KeyTempo is a free online BPM detector and musical key detection tool for DJs,
                producers, and musicians. Instantly analyze any audio file to find its tempo (BPM),
                detect the musical key (major or minor), trim leading silence, and export a properly
                named WAV file — all for free, with no upload required. 100% in-browser processing.
              </p>
              <p>
                Features: free BPM detection, free key detection, online BPM finder, online key
                finder, audio tempo detection, camelot wheel key detection, harmonic mixing, silence
                trimmer, WAV export, MP3 analysis, M4A support. Works with WAV, MP3, and M4A files.
                Perfect for DJs preparing sets, producers labeling samples, and musicians finding
                the key of a song. No sign-up, no upload, completely free.
              </p>
              <ul>
                <li>Free BPM detector — find the tempo of any song instantly</li>
                <li>Free key detection — detect major and minor keys with high accuracy</li>
                <li>Silence trimming — remove dead air from the start and end of tracks</li>
                <li>WAV export — download a properly named file ready for your DAW or DJ software</li>
                <li>Works offline — no files are uploaded to any server</li>
              </ul>
            </div>

            <AudioAnalyzer />
          </div>
        </div>

      </div>

      <p className="fixed bottom-4 right-4 text-[11px] text-muted-foreground">
        All processing happens locally in your browser. No files are uploaded.
      </p>
    </main>
  );
}
