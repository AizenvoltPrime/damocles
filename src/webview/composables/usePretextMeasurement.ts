import { prepare, layout, type PreparedText } from '@chenglou/pretext';

let bodyFont = '';
let monoFont = '';
let bodyLineHeight = 22;
let codeLineHeight = 18;
let ready = false;

const prepareCache = new Map<string, PreparedText>();
const layoutCache = new Map<string, number>();

export function isReady(): boolean {
  return ready;
}

export async function initFonts(): Promise<void> {
  if (ready) return;
  await document.fonts.ready;

  const style = getComputedStyle(document.documentElement);
  const family = style.getPropertyValue('--vscode-editor-font-family').trim() || 'monospace';
  const size = style.getPropertyValue('--vscode-editor-font-size').trim() || '13px';

  bodyFont = `400 14px -apple-system, BlinkMacSystemFont, "Segoe UI", ${family}, sans-serif`;
  monoFont = `400 ${size} ${family}`;
  bodyLineHeight = 22;
  codeLineHeight = 18;
  ready = true;
}

function getPrepared(text: string, font: string): PreparedText {
  const key = `${font}\0${text}`;
  let cached = prepareCache.get(key);
  if (!cached) {
    cached = prepare(text, font);
    prepareCache.set(key, cached);
  }
  return cached;
}

export function estimateTextHeight(text: string, containerWidth: number): number {
  if (!ready || !text) return bodyLineHeight;

  const cacheKey = `t\0${text}\0${containerWidth}`;
  const cached = layoutCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const prepared = getPrepared(text, bodyFont);
  const result = layout(prepared, containerWidth, bodyLineHeight);
  layoutCache.set(cacheKey, result.height);
  return result.height;
}

export function estimateCodeHeight(code: string, containerWidth: number): number {
  if (!ready || !code) return codeLineHeight;

  const codePadding = 24;
  const cacheKey = `c\0${code}\0${containerWidth}`;
  const cached = layoutCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const prepared = getPrepared(code, monoFont);
  const innerWidth = Math.max(60, containerWidth - codePadding);
  const result = layout(prepared, innerWidth, codeLineHeight);
  const height = result.height + 16;
  layoutCache.set(cacheKey, height);
  return height;
}

export function invalidateLayoutCache(): void {
  layoutCache.clear();
}
