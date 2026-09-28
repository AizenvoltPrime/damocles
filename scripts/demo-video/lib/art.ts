import fs from 'node:fs';
import path from 'node:path';
import type { Browser } from 'patchright';
import { WINDOW_W, WINDOW_H } from './stage.ts';

export const CANVAS_W = 1920;
export const CANVAS_H = 1080;
const TITLE_BAR_H = 34;
const RADIUS = 12;
export const WINDOW_X = (CANVAS_W - WINDOW_W) / 2;
const WINDOW_Y = 36;
/** Where the captured webview frames go on the canvas. */
export const CONTENT_X = WINDOW_X;
export const CONTENT_Y = WINDOW_Y + TITLE_BAR_H;
/** Vertical centre of the caption band below the window. */
export const CAPTION_CENTER_Y = Math.round((CONTENT_Y + WINDOW_H + CANVAS_H) / 2);

const BACKDROP_CSS = `
  html, body { margin: 0; width: ${CANVAS_W}px; height: ${CANVAS_H}px; overflow: hidden; }
  body { font-family: "Segoe UI", system-ui, sans-serif; }
  .bg {
    position: absolute; inset: 0;
    background:
      radial-gradient(900px 600px at 12% 8%, rgba(38,139,210,.28), transparent 70%),
      radial-gradient(800px 700px at 92% 95%, rgba(42,161,152,.25), transparent 70%),
      radial-gradient(600px 500px at 85% 10%, rgba(108,113,196,.18), transparent 70%),
      linear-gradient(160deg, #00212b 0%, #002b36 55%, #01313d 100%);
  }
  .grid {
    position: absolute; inset: 0; opacity: .07;
    background-image: linear-gradient(#93a1a1 1px, transparent 1px), linear-gradient(90deg, #93a1a1 1px, transparent 1px);
    background-size: 48px 48px;
    mask-image: radial-gradient(ellipse at center, #000 20%, transparent 75%);
  }`;

function frameHtml(iconDataUrl: string): string {
  const [x0, y0, x1, y1] = [CONTENT_X, CONTENT_Y, CONTENT_X + WINDOW_W, CONTENT_Y + WINDOW_H];
  const hole = `M${x0},${y0} H${x1} V${y1 - RADIUS} A${RADIUS},${RADIUS} 0 0 1 ${x1 - RADIUS},${y1} H${x0 + RADIUS} A${RADIUS},${RADIUS} 0 0 1 ${x0},${y1 - RADIUS} Z`;
  // CSS image masks use alpha, so the hole is an even-odd subpath of one full-canvas path, not a black fill.
  const mask = `<svg xmlns='http://www.w3.org/2000/svg' width='${CANVAS_W}' height='${CANVAS_H}'><path fill='white' fill-rule='evenodd' d='M0,0 H${CANVAS_W} V${CANVAS_H} H0 Z ${hole}'/></svg>`;
  return `<!doctype html><html><head><style>${BACKDROP_CSS}
  .masked { position: absolute; inset: 0; -webkit-mask: url("data:image/svg+xml,${encodeURIComponent(mask)}"); }
  .window {
    position: absolute; left: ${WINDOW_X}px; top: ${WINDOW_Y}px; width: ${WINDOW_W}px; height: ${TITLE_BAR_H + WINDOW_H}px;
    border-radius: ${RADIUS}px; background: #002b36;
    box-shadow: 0 40px 90px rgba(0,0,0,.55), 0 0 0 1px rgba(147,161,161,.18);
  }
  .titlebar {
    position: absolute; left: ${WINDOW_X}px; top: ${WINDOW_Y}px; width: ${WINDOW_W}px; height: ${TITLE_BAR_H}px;
    border-radius: ${RADIUS}px ${RADIUS}px 0 0; background: #002c39; border-bottom: 1px solid #00212b; box-sizing: border-box;
    display: flex; align-items: center; justify-content: center; color: #93a1a1; font-size: 14px;
  }
  .titlebar img { position: absolute; left: 14px; width: 18px; height: 18px; }
  .controls { position: absolute; right: 18px; display: flex; gap: 28px; color: #839496; font-size: 14px; }
  </style></head><body>
  <div class="masked"><div class="bg"></div><div class="grid"></div><div class="window"></div></div>
  <div class="titlebar"><img src="${iconDataUrl}">Damocles  &mdash;  acme-api  &mdash;  Visual Studio Code
    <div class="controls"><span>&#x2014;</span><span>&#x25A2;</span><span>&#x2715;</span></div></div>
  </body></html>`;
}

function cardHtml(iconDataUrl: string, kind: 'intro' | 'outro'): string {
  const body = kind === 'intro'
    ? `<div class="tag">An AI coding agent inside VS Code</div>
       <div class="pills"><span>Claude &amp; GPT</span><span>Diff approval</span><span>Plan mode</span><span>Subagents</span><span>Teams</span><span>Rewind</span></div>`
    : `<div class="tag">Install it from the VS Code Marketplace</div>
       <div class="url">github.com/AizenvoltPrime/damocles</div>`;
  return `<!doctype html><html><head><style>${BACKDROP_CSS}
  .center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #fdf6e3; }
  img { width: 190px; height: 190px; filter: drop-shadow(0 18px 40px rgba(38,139,210,.45)); }
  h1 { margin: 26px 0 8px; font-size: 104px; font-weight: 600; letter-spacing: -1px; }
  .tag { font-size: 38px; color: #93a1a1; }
  .pills { display: flex; gap: 14px; margin-top: 38px; }
  .pills span { font-size: 24px; color: #eee8d5; padding: 8px 20px; border-radius: 999px; background: rgba(7,54,66,.85); border: 1px solid rgba(42,161,152,.55); }
  .url { margin-top: 30px; font-size: 32px; color: #2aa198; font-family: "Cascadia Code", Consolas, monospace; }
  </style></head><body><div class="bg"></div><div class="grid"></div>
  <div class="center"><img src="${iconDataUrl}"><h1>Damocles</h1>${body}</div></body></html>`;
}

export interface Artwork {
  frame: string;
  intro: string;
  outro: string;
}

/** Renders the static layers ffmpeg composites: the window frame (transparent where the webview goes) and the title cards. */
export async function renderArtwork(browser: Browser, repoRoot: string, outDir: string): Promise<Artwork> {
  fs.mkdirSync(outDir, { recursive: true });
  const icon = `data:image/png;base64,${fs.readFileSync(path.join(repoRoot, 'resources', 'icon.png')).toString('base64')}`;
  const page = await browser.newPage({ viewport: { width: CANVAS_W, height: CANVAS_H }, deviceScaleFactor: 1 });
  const shoot = async (html: string, name: string, transparent: boolean): Promise<string> => {
    await page.setContent(html, { waitUntil: 'load' });
    const file = path.join(outDir, name);
    await page.screenshot({ path: file, omitBackground: transparent });
    return file;
  };
  const art = {
    frame: await shoot(frameHtml(icon), 'frame.png', true),
    intro: await shoot(cardHtml(icon, 'intro'), 'intro.png', false),
    outro: await shoot(cardHtml(icon, 'outro'), 'outro.png', false),
  };
  await page.close();
  return art;
}
