import type { DamoclesOverlayApi, RasterArt } from '../../preload/overlay-channels';

function loadSvg(svg: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return image.decode().then(() => image);
}

/** Draws main's art on a canvas, with this page's loaded --d-font for its text, and encodes it as PNG. */
export async function rasterize(art: RasterArt): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = art.width;
  canvas.height = art.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No 2D canvas');
  const family = getComputedStyle(document.documentElement).getPropertyValue('--d-font').trim() || 'sans-serif';
  for (const op of art.ops) {
    context.save();
    if (op.kind === 'svg') {
      const image = await loadSvg(op.svg);
      context.drawImage(image, 0, 0, art.width, art.height);
    } else {
      const font = `${op.weight} ${op.size * art.scale}px ${family}`;
      // A canvas never fetches a webfont itself; without the load the first draw falls back to a system face.
      await document.fonts.load(font, op.text);
      context.font = font;
      context.fillStyle = op.color;
      context.textAlign = 'left';
      context.textBaseline = 'alphabetic';
      const ink = context.measureText(op.text);
      const x = op.x * art.scale - (ink.actualBoundingBoxRight - ink.actualBoundingBoxLeft) / 2;
      // A whole-pixel baseline keeps the digits' horizontal strokes sharp at 16 px.
      const y = Math.round(op.y * art.scale + (ink.actualBoundingBoxAscent - ink.actualBoundingBoxDescent) / 2);
      context.fillText(op.text, x, y);
    }
    context.restore();
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('The canvas produced no PNG');
  return new Uint8Array(await blob.arrayBuffer());
}

/** Answers each of main's rasterize requests once, with null when it cannot be drawn. */
export function installRasterizer(api: DamoclesOverlayApi, draw: (art: RasterArt) => Promise<Uint8Array> = rasterize): () => void {
  return api.onRasterize((request) => {
    draw(request.art).then(
      (png) => api.rasterized(request.id, png),
      () => api.rasterized(request.id, null),
    );
  });
}
