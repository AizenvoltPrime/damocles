import fs from 'node:fs';
import path from 'node:path';
import type { Browser, Page } from 'patchright';
import { WINDOW_W, WINDOW_H, type Caption } from './stage.ts';

export const CANVAS_W = 1920;
export const CANVAS_H = 1080;
export const TITLE_BAR_H = 34;
const RADIUS = 12;
export const WINDOW_X = (CANVAS_W - WINDOW_W) / 2;
export const WINDOW_Y = 36;
/** Where the captured webview frames go on the canvas. */
export const CONTENT_X = WINDOW_X;
export const CONTENT_Y = WINDOW_Y + TITLE_BAR_H;
/** The caption band below the window. */
export const CAPTION_Y = CONTENT_Y + WINDOW_H;
export const CAPTION_H = CANVAS_H - CAPTION_Y;

/**
 * The backdrop is larger than the canvas and drifts under it. `driftAt` (cards, rendered in the browser) and
 * `driftExpr` (scenes, cropped by ffmpeg) are the same curve, so a crossfade joins two matching backdrops.
 */
const DRIFT = { x: 120, y: 70, periodX: 41, periodY: 29 };
export const BACKDROP_W = CANVAS_W + 2 * DRIFT.x;
export const BACKDROP_H = CANVAS_H + 2 * DRIFT.y;
export const driftAt = (t: number) => ({
  x: DRIFT.x * (1 + Math.sin((2 * Math.PI * t) / DRIFT.periodX)),
  y: DRIFT.y * (1 + Math.cos((2 * Math.PI * t) / DRIFT.periodY)),
});
export const driftExpr = (t: string) => ({
  x: `${DRIFT.x}*(1+sin(2*PI*(${t})/${DRIFT.periodX}))`,
  y: `${DRIFT.y}*(1+cos(2*PI*(${t})/${DRIFT.periodY}))`,
});

export const ACCENTS = { blue: '#268bd2', cyan: '#2aa198', green: '#859900', yellow: '#b58900', orange: '#cb4b16', violet: '#6c71c4', magenta: '#d33682' } as const;
export type Accent = keyof typeof ACCENTS;

const FONTS = `body { margin: 0; font-family: "Segoe UI", system-ui, sans-serif; }`;

const BACKDROP_HTML = `<!doctype html><html><head><style>${FONTS}
  html, body { width: ${BACKDROP_W}px; height: ${BACKDROP_H}px; overflow: hidden; }
  .bg {
    position: absolute; inset: 0;
    background:
      radial-gradient(1000px 700px at 14% 10%, rgba(38,139,210,.30), transparent 70%),
      radial-gradient(900px 800px at 90% 92%, rgba(42,161,152,.27), transparent 70%),
      radial-gradient(700px 600px at 84% 12%, rgba(108,113,196,.22), transparent 70%),
      radial-gradient(600px 500px at 30% 95%, rgba(211,54,130,.10), transparent 70%),
      linear-gradient(160deg, #00212b 0%, #002b36 55%, #01313d 100%);
  }
  .grid {
    position: absolute; inset: 0; opacity: .07;
    background-image: linear-gradient(#93a1a1 1px, transparent 1px), linear-gradient(90deg, #93a1a1 1px, transparent 1px);
    background-size: 48px 48px;
    mask-image: radial-gradient(ellipse at center, #000 20%, transparent 75%);
  }
  </style></head><body><div class="bg"></div><div class="grid"></div></body></html>`;

function frameHtml(iconDataUrl: string): string {
  const [x0, y0, x1, y1] = [CONTENT_X, CONTENT_Y, CONTENT_X + WINDOW_W, CONTENT_Y + WINDOW_H];
  const hole = `M${x0},${y0} H${x1} V${y1 - RADIUS} A${RADIUS},${RADIUS} 0 0 1 ${x1 - RADIUS},${y1} H${x0 + RADIUS} A${RADIUS},${RADIUS} 0 0 1 ${x0},${y1 - RADIUS} Z`;
  // CSS image masks use alpha, so the hole is an even-odd subpath of one full-canvas path, not a black fill.
  const mask = `<svg xmlns='http://www.w3.org/2000/svg' width='${CANVAS_W}' height='${CANVAS_H}'><path fill='white' fill-rule='evenodd' d='M0,0 H${CANVAS_W} V${CANVAS_H} H0 Z ${hole}'/></svg>`;
  return `<!doctype html><html><head><style>${FONTS}
  html, body { width: ${CANVAS_W}px; height: ${CANVAS_H}px; overflow: hidden; background: transparent; }
  .masked { position: absolute; inset: 0; -webkit-mask: url("data:image/svg+xml,${encodeURIComponent(mask)}"); }
  .window {
    position: absolute; left: ${WINDOW_X}px; top: ${WINDOW_Y}px; width: ${WINDOW_W}px; height: ${TITLE_BAR_H + WINDOW_H}px;
    border-radius: ${RADIUS}px; background: #002b36;
    box-shadow: 0 40px 100px rgba(0,0,0,.6), 0 0 0 1px rgba(147,161,161,.2), 0 0 80px rgba(38,139,210,.12);
  }
  .titlebar {
    position: absolute; left: ${WINDOW_X}px; top: ${WINDOW_Y}px; width: ${WINDOW_W}px; height: ${TITLE_BAR_H}px;
    border-radius: ${RADIUS}px ${RADIUS}px 0 0; background: #002c39; border-bottom: 1px solid #00212b; box-sizing: border-box;
  }
  .titlebar img { position: absolute; left: 14px; top: 8px; width: 18px; height: 18px; }
  .controls { position: absolute; right: 18px; top: 7px; display: flex; gap: 28px; color: #839496; font-size: 14px; }
  </style></head><body>
  <div class="masked"><div class="window"></div></div>
  <div class="titlebar"><img src="${iconDataUrl}">
    <div class="controls"><span>&#x2014;</span><span>&#x25A2;</span><span>&#x2715;</span></div></div>
  </body></html>`;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function captionHtml(chapter: string, accent: Accent, text: string): string {
  return `<!doctype html><html><head><style>${FONTS}
  html, body { width: ${CANVAS_W}px; height: ${CAPTION_H}px; overflow: hidden; background: transparent; }
  body { display: flex; align-items: center; justify-content: center; }
  .pill {
    display: inline-flex; align-items: center; gap: 18px; padding: 9px 30px 9px 10px; border-radius: 999px;
    background: rgba(0,30,38,.9); border: 1px solid rgba(147,161,161,.24);
    box-shadow: 0 10px 28px rgba(0,0,0,.45), inset 0 1px 0 rgba(253,246,227,.06);
  }
  .chip {
    font-size: 15px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; color: #002b36;
    background: ${ACCENTS[accent]}; padding: 7px 14px; border-radius: 999px;
  }
  .text { font-size: 29px; font-weight: 600; color: #fdf6e3; white-space: nowrap; }
  </style></head><body><div class="pill"><span class="chip">${escapeHtml(chapter)}</span><span class="text">${escapeHtml(text)}</span></div></body></html>`;
}

/** Animations are authored as CSS and rendered paused, one seek per frame, so card timing never depends on the machine. */
function cardHtml(iconDataUrl: string, backdropUrl: string, kind: 'intro' | 'outro'): string {
  const pills = ['Claude, GPT &amp; more', 'Diff approval', 'Plan mode', 'Folder per panel', 'Subagents', 'Teams', '/steer', 'Usage stats'];
  const body = kind === 'intro'
    ? `<div class="tag rise" style="animation-delay:.75s">An AI coding agent inside VS Code</div>
       <div class="pills">${pills.map((p, i) => `<span class="pop" style="animation-delay:${(1.15 + i * 0.09).toFixed(2)}s">${p}</span>`).join('')}</div>`
    : `<div class="tag rise" style="animation-delay:.55s">For VS Code, Windows, macOS and Linux</div>
       <div class="url rise" style="animation-delay:.9s">github.com/AizenvoltPrime/damocles</div>`;
  return `<!doctype html><html><head><style>${FONTS}
  html, body { width: ${CANVAS_W}px; height: ${CANVAS_H}px; overflow: hidden; background: #002b36; }
  #backdrop { position: absolute; left: 0; top: 0; width: ${BACKDROP_W}px; height: ${BACKDROP_H}px; }
  .center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #fdf6e3; }
  .logo { position: relative; width: 190px; height: 190px; animation: logo 1.1s cubic-bezier(.2,.8,.2,1) both; }
  .logo img { width: 100%; height: 100%; filter: drop-shadow(0 18px 40px rgba(38,139,210,.45)); }
  .halo {
    position: absolute; left: 50%; top: 50%; width: 520px; height: 520px; margin: -260px 0 0 -260px; border-radius: 50%;
    background: radial-gradient(closest-side, rgba(42,161,152,.35), rgba(38,139,210,.12) 55%, transparent);
    animation: halo 1.6s ease-out both, breathe 3.2s ease-in-out 1.6s infinite alternate;
  }
  h1 { margin: 26px 0 6px; font-size: 104px; font-weight: 600; letter-spacing: -1px; }
  .rule { height: 3px; width: 240px; border-radius: 3px; background: linear-gradient(90deg, #268bd2, #2aa198, #859900); margin-bottom: 22px;
    transform-origin: center; animation: grow .8s cubic-bezier(.2,.8,.2,1) .5s both; }
  .tag { font-size: 38px; color: #93a1a1; }
  .pills { display: flex; flex-wrap: wrap; justify-content: center; gap: 14px; margin-top: 40px; max-width: 1760px; }
  .pills span { font-size: 24px; color: #eee8d5; padding: 8px 20px; border-radius: 999px; background: rgba(7,54,66,.85); border: 1px solid rgba(42,161,152,.55); }
  .url { margin-top: 30px; font-size: 34px; color: #2aa198; font-family: "Cascadia Code", Consolas, monospace;
    padding: 12px 28px; border-radius: 12px; background: rgba(0,30,38,.8); border: 1px solid rgba(42,161,152,.45); }
  .rise { animation: rise .8s cubic-bezier(.2,.8,.2,1) both; }
  .pop { animation: pop .55s cubic-bezier(.3,1.5,.5,1) both; }
  .fadein { position: absolute; inset: 0; background: #000; animation: fadeout .6s ease-out both; pointer-events: none; }
  @keyframes logo { from { opacity: 0; transform: scale(.7) rotate(-25deg); } to { opacity: 1; transform: none; } }
  @keyframes halo { from { opacity: 0; transform: scale(.4); } to { opacity: 1; transform: scale(1); } }
  @keyframes breathe { from { transform: scale(1); } to { transform: scale(1.12); } }
  @keyframes grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
  @keyframes rise { from { opacity: 0; transform: translateY(26px); } to { opacity: 1; transform: none; } }
  @keyframes pop { from { opacity: 0; transform: scale(.6); } to { opacity: 1; transform: none; } }
  @keyframes fadeout { from { opacity: 1; } to { opacity: 0; } }
  </style></head><body><img id="backdrop" src="${backdropUrl}">
  <div class="center">
    <div class="logo"><div class="halo"></div><img src="${iconDataUrl}" style="position:relative"></div>
    <h1 class="rise" style="animation-delay:.3s">Damocles</h1><div class="rule"></div>${body}
  </div>${kind === 'intro' ? '<div class="fadein"></div>' : ''}</body></html>`;
}

export interface Artwork {
  backdrop: string;
  frame: string;
}

const dataUrl = (file: string, mime: string) => `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;

async function withPage<T>(browser: Browser, width: number, height: number, fn: (page: Page) => Promise<T>): Promise<T> {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  try {
    return await fn(page);
  } finally {
    await page.close();
  }
}

/** The static layers every scene composites: the drifting backdrop and the window chrome, transparent where the webview goes. */
export async function renderArtwork(browser: Browser, repoRoot: string, outDir: string): Promise<Artwork> {
  fs.mkdirSync(outDir, { recursive: true });
  const icon = dataUrl(path.join(repoRoot, 'resources', 'icon.png'), 'image/png');
  const backdrop = path.join(outDir, 'backdrop.png');
  const frame = path.join(outDir, 'frame.png');
  await withPage(browser, BACKDROP_W, BACKDROP_H, async (page) => {
    await page.setContent(BACKDROP_HTML, { waitUntil: 'load' });
    await page.screenshot({ path: backdrop });
  });
  await withPage(browser, CANVAS_W, CANVAS_H, async (page) => {
    await page.setContent(frameHtml(icon), { waitUntil: 'load' });
    await page.screenshot({ path: frame, omitBackground: true });
  });
  return { backdrop, frame };
}

/** One transparent PNG per caption, sized to the caption band. */
export async function renderCaptions(browser: Browser, captions: Caption[], chapter: string, accent: Accent, outDir: string): Promise<string[]> {
  return withPage(browser, CANVAS_W, CAPTION_H, async (page) => {
    const files: string[] = [];
    for (const [i, c] of captions.entries()) {
      await page.setContent(captionHtml(chapter, accent, c.text), { waitUntil: 'load' });
      const file = path.join(outDir, `caption-${i}.png`);
      await page.screenshot({ path: file, omitBackground: true });
      files.push(file);
    }
    return files;
  });
}

/** Renders an animated title card to numbered JPEGs; `t0` is where the card sits in the video, for the backdrop drift. */
export async function renderCard(browser: Browser, repoRoot: string, art: Artwork, kind: 'intro' | 'outro', seconds: number, fps: number, t0: number, framesDir: string): Promise<string> {
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  const icon = dataUrl(path.join(repoRoot, 'resources', 'icon.png'), 'image/png');
  await withPage(browser, CANVAS_W, CANVAS_H, async (page) => {
    await page.setContent(cardHtml(icon, dataUrl(art.backdrop, 'image/png'), kind), { waitUntil: 'load' });
    const frames = Math.round(seconds * fps);
    for (let n = 0; n < frames; n++) {
      const t = n / fps;
      const d = driftAt(t0 + t);
      await page.evaluate(({ ms, x, y }) => {
        for (const a of document.getAnimations()) {
          a.pause();
          a.currentTime = ms;
        }
        document.getElementById('backdrop')!.style.transform = `translate(${-x}px, ${-y}px)`;
      }, { ms: t * 1000, x: d.x, y: d.y });
      await page.screenshot({ path: path.join(framesDir, `${String(n).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 95 });
    }
  });
  return path.join(framesDir, '%05d.jpg');
}
