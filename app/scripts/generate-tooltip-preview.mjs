#!/usr/bin/env node

/**
 * Generate tooltip-animations-preview.html from tooltipMediaData.ts
 * Run this after adding new animations to automatically update the preview.
 *
 * Usage: node scripts/generate-tooltip-preview.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const dataFile = path.join(__dir, '../src/renderer/components/tooltipMediaData.ts');
const outputFile = path.join(__dir, '../../tooltip-animations-preview.html');

// Read and parse the tooltipMediaData.ts file
const content = fs.readFileSync(dataFile, 'utf8');

// Extract the ANIMATIONS array using regex
const match = content.match(/export const ANIMATIONS: TooltipAnimation\[\] = \[([\s\S]*?)\];/);
if (!match) {
  console.error('❌ Could not find ANIMATIONS array in tooltipMediaData.ts');
  process.exit(1);
}

// Simple parser for the animation objects
const animationsText = match[1];
const animationBlocks = animationsText.match(/\{\s*id:[\s\S]*?\n\s*\},?/g);

if (!animationBlocks) {
  console.error('❌ Could not parse animation blocks');
  process.exit(1);
}

const animations = animationBlocks.map((block) => {
  const idMatch = block.match(/id:\s*'([^']+)'/);
  const labelMatch = block.match(/label:\s*'([^']+)'/);
  const descMatch = block.match(/description:\s*'([^']+)'/);
  const svgMatch = block.match(/svgContent:\s*`([\s\S]*?)`/);

  return {
    id: idMatch?.[1] || '',
    label: labelMatch?.[1] || '',
    description: descMatch?.[1] || '',
    svg: svgMatch?.[1]?.trim() || '',
  };
});

// Generate HTML
const cardsHtml = animations
  .map(
    (anim) => `
    <!-- ${anim.label} -->
    <div class="card">
      <h2>${anim.label}</h2>
      <svg viewBox="0 0 260 110" width="260" height="110">
        ${anim.svg}
      </svg>
      <p>${anim.description}</p>
    </div>
  `,
  )
  .join('\n');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tooltip Animations Preview</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0a0a0a;
      color: #e6e6e6;
      padding: 40px 20px;
    }
    h1 { text-align: center; margin-bottom: 40px; font-size: 28px; }
    .meta {
      text-align: center;
      font-size: 12px;
      color: #666;
      margin-bottom: 20px;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 40px;
    }
    .card {
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 12px;
      padding: 24px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
    }
    .card h2 {
      font-size: 16px;
      font-weight: 600;
      text-align: center;
    }
    .card svg {
      max-width: 100%;
      height: auto;
    }
    .card p {
      font-size: 12px;
      color: #999;
      text-align: center;
      line-height: 1.4;
    }
    /* Theme colors */
    :root {
      --accent: #3df8e8;
      --accent-rgb: 61, 248, 232;
      --red: #ff3131;
      --text: #e6e6e6;
      --text-mut: #999999;
      /* Keep this list in step with :root in src/renderer/styles.css — an
         animation using a var the preview does not define renders invisible
         here while looking fine in the app, which is how a missing trace got
         shipped once already. */
      --text: #e8edf4;
      --text-dim: #9aa7ba;
      --bg-1: #10141b;
      --amber: #ffb454;
      --red: #ff5c6c;
      --line: #333333;
      --bg-2: #222222;
      --bg-3: #2a2a2a;
      --violet: #8b7dff;
      --amber: #ffb02e;
    }
  </style>
</head>
<body>
  <h1>Tooltip Animations Preview</h1>
  <div class="meta">
    Auto-generated from <code>tooltipMediaData.ts</code> — run <code>node scripts/generate-tooltip-preview.mjs</code> after adding new animations
  </div>
  <div class="container">
${cardsHtml}
  </div>
</body>
</html>`;

fs.writeFileSync(outputFile, html, 'utf8');
console.log(`✅ Generated preview: ${outputFile}`);
console.log(`📊 Included ${animations.length} animation(s)`);
