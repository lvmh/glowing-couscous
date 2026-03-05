// Generates favicon PNGs from the recolored hotelsoap SVG using sharp.
// Run with: node scripts/gen-icons.mjs

import sharp from "sharp";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "../public");
const appDir    = join(__dirname, "../app");

// Recolored SVG: #e48cff → #6BBF23 (kawasaki green), #31617c → #1a3d06 (dark green)
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="512" height="512" version="1.1" viewBox="0 0 51.083 49.372" xmlns="http://www.w3.org/2000/svg">
 <defs>
  <clipPath id="clipPath1101">
   <circle cx="51.772" cy="76.341" r="23.044" fill-opacity="0" stroke-width=".31626"/>
  </clipPath>
  <clipPath id="clipPath1146">
   <circle cx="52.035" cy="76.279" r="23.044" fill="#6BBF23"/>
   <path transform="translate(.22088 -.09376)" d="m17.75 98.975 48.052 17.868 6.0366-19.559-5.0708-8.4513-5.4471-3.6425-7.3505-1.4283-2.1732-4.1049-0.24147-7.244-7.9889-5.0471-2.1527 1.7558-0.24147-6.1258-5.137-5.8141s2.4809 4.6067-11.766 5.3311z" clip-path="url(#clipPath1101)" fill="#1a3d06"/>
  </clipPath>
 </defs>
 <g transform="translate(-26.495 -52.503)">
  <g transform="rotate(23 51.903 76.31)" clip-path="url(#clipPath1146)">
   <circle cx="52.035" cy="76.279" r="23.044" fill="#6BBF23"/>
   <path transform="translate(.22088 -.09376)" d="m17.75 98.975 48.052 17.868 6.0366-19.559-5.0708-8.4513-5.4471-3.6425-7.3505-1.4283-2.1732-4.1049-0.24147-7.244-7.9889-5.0471-2.1527 1.7558-0.24147-6.1258-5.137-5.8141s2.4809 4.6067-11.766 5.3311z" clip-path="url(#clipPath1101)" fill="#1a3d06"/>
   <g transform="matrix(1.9665 0 0 1.2825 -43.203 -35.793)" fill="#fff" aria-label="h">
    <path d="m50.328 87.289-0.762 0.0254-0.2032-4.4704c-0.1016-2.54-1.4224-3.2512-3.7846-3.2512-0.9398 0-1.778 0.2794-2.4384 0.7366l0.0508-5.461 0.8382-0.0254-0.1778-2.1844-3.2258 0.2286-0.0508 2.032 0.8382-0.0254 0.0254 13.335-0.8128 0.0508 0.2286 2.0828 2.9464-0.0254 0.0508-2.286-0.762 0.0508 0.0254-5.0292c0.4064-2.5146 2.5654-2.0066 2.5908-0.7874l0.1778 5.2324-0.5334 0.0254 0.1016 2.9464 5.0038-0.0762z" fill="#fff"/>
   </g>
   <g transform="matrix(2.3686 0 0 1.1418 -45.424 -10.71)" fill="#fff" aria-label="s">
    <path d="m45.299 82.895-1.143-0.0508c-0.9144-0.0254-1.7526-0.9652-1.7526-1.9304 0-0.2794 0-0.4318-0.0254-0.4826-0.0254 0.381 0-0.2032 0 0 0.127-1.143 0.6096-2.159 1.2446-2.2352 0.3556-0.0508 1.0414-0.1016 1.0414 1.2192l-0.7112 0.0254 0.1524 2.794 4.9784 0.127-0.0508-3.0988-0.6858 0.0254-0.2032-0.7112c-0.4318-1.5748-1.2446-1.4732-3.0988-1.4732h-1.7018c-2.0828 0-2.5146 1.8288-2.2352 3.5814l0.1524 0.8382c0.2794 1.778 0.9906 2.7686 2.6416 2.9972 0.8128 0.1016 1.1938 0.3302 1.27 1.1938 0.0508 0.9398 0.0508 0.5588-0.0508 1.4478-0.127 1.1176-2.6416 1.6256-2.7178 0.1524l0.762 0.0254v-2.1844l-2.5908 0.1016 0.0508 1.9812 0.4826 0.0254 0.0508 1.0414c0.1016 2.7178 3.2512 2.1336 4.699 2.2352 2.1336 0.127 2.667-0.6604 2.7686-2.4638 0.0508-1.0922 0.1016-0.7366 0.127-2.2352 0.0508-1.651-0.508-2.8702-3.4544-2.9464z" fill="#fff"/>
   </g>
  </g>
 </g>
</svg>`;

const svgBuf = Buffer.from(svg);

// Write the SVG to public/ and app/ (Next.js App Router auto-uses app/icon.svg)
writeFileSync(join(publicDir, "icon.svg"), svg);
writeFileSync(join(appDir, "icon.svg"), svg);
console.log("✦ wrote icon.svg");

// Generate PNGs
const sizes = [
  { size: 32,  out: join(publicDir, "icon-32x32.png") },
  { size: 180, out: join(publicDir, "apple-icon.png") },
  { size: 192, out: join(publicDir, "icon-192.png") },
];

for (const { size, out } of sizes) {
  await sharp(svgBuf, { density: Math.round(size * 3.78) })
    .resize(size, size)
    .png()
    .toFile(out);
  console.log(`✦ wrote ${size}x${size} → ${out.split("/").pop()}`);
}

console.log("✧ done");
