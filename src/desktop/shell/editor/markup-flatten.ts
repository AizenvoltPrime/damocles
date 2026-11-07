import { arrowWings, imageScale, type MarkupPoint } from './markup';
import { pinNumbers, type MarkupSession } from './markup-session';
import { BOX_RADIUS_PX, PIN_RING_PX, pinInsetPx, pinPx, STROKE_PX, WING_PX } from './markup-style';

// The PNG the designer gets: the capture with the marks drawn as the layer shows them.

export interface MarkupColors {
  readonly design: string;
  readonly onDesign: string;
  readonly designText: string;
  readonly bg: string;
}

// Canvas reads no var(); a probe element resolves each token to the colour the theme gives it now.
export function resolveMarkupColors(): MarkupColors {
  const probe = document.createElement('span');
  probe.hidden = true;
  document.body.append(probe);
  const read = (token: string): string => {
    probe.style.color = `var(${token})`;
    return getComputedStyle(probe).color;
  };
  try {
    return { design: read('--d-design'), onDesign: read('--d-on-design'), designText: read('--d-design-text'), bg: read('--d-bg') };
  } finally {
    probe.remove();
  }
}

// The PNG scales the layer's sizes by its px per displayed shell px, and keeps a pin's number legible on a small capture.
const PIN_MIN_DEVICE_PX = 22;

/** The capture with the marks flattened onto it, as a PNG data URL at the capture's own size. */
export async function flattenMarkup(session: MarkupSession, displayedWidth: number, colors: MarkupColors): Promise<string> {
  const { freeze } = session;
  const image = new Image();
  image.src = freeze.png;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = freeze.imageWidth;
  canvas.height = freeze.imageHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d canvas context for the markup image');
  context.drawImage(image, 0, 0);

  const scale = imageScale(freeze);
  const p = freeze.imageWidth / displayedWidth;
  const device = (point: MarkupPoint): MarkupPoint => [point[0] * scale, point[1] * scale];

  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.lineWidth = STROKE_PX * p;
  context.strokeStyle = colors.design;
  for (const mark of session.marks) {
    if (mark.type === 'pin') continue;
    context.beginPath();
    if (mark.type === 'pen') {
      const points = mark.points.map(device);
      context.moveTo(...points[0]!);
      for (let index = 1; index < points.length - 1; index++) {
        const [x, y] = points[index]!;
        const [nx, ny] = points[index + 1]!;
        context.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
      }
      if (points.length > 1) context.lineTo(...points[points.length - 1]!);
      context.stroke();
    } else if (mark.type === 'arrow') {
      const [tail, head] = mark.points as [MarkupPoint, MarkupPoint];
      const [left, right] = arrowWings(tail, head, (WING_PX * p) / scale).map(device);
      context.moveTo(...device(tail));
      context.lineTo(...device(head));
      context.moveTo(...left!);
      context.lineTo(...device(head));
      context.lineTo(...right!);
      context.stroke();
    } else {
      const [a, b] = mark.points.map(device) as [MarkupPoint, MarkupPoint];
      context.roundRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), BOX_RADIUS_PX * p);
      context.globalAlpha = 0.08;
      context.fillStyle = colors.design;
      context.fill();
      context.globalAlpha = 1;
      context.stroke();
    }
  }

  const diameter = Math.max(pinPx() * p, PIN_MIN_DEVICE_PX);
  const radius = diameter / 2;
  const ring = PIN_RING_PX * p;
  const inset = Math.max(pinInsetPx() * p, radius + ring);
  const numbers = pinNumbers(session.marks);
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = `bold ${Math.round(0.55 * diameter)}px system-ui, sans-serif`;
  for (const mark of session.marks) {
    if (mark.type !== 'pin') continue;
    const [ax, ay] = device(mark.at);
    const x = Math.min(freeze.imageWidth - inset, Math.max(inset, ax));
    const y = Math.min(freeze.imageHeight - inset, Math.max(inset, ay));
    const circle = (r: number): void => {
      context.beginPath();
      context.arc(x, y, r, 0, 2 * Math.PI);
    };
    circle(radius + ring);
    context.fillStyle = colors.bg;
    context.fill();
    circle(radius);
    context.fillStyle = mark.kind === 'change' ? colors.design : colors.bg;
    context.fill();
    if (mark.kind === 'note') {
      circle(radius - ring / 2);
      context.lineWidth = ring;
      context.strokeStyle = colors.design;
      context.stroke();
    }
    context.fillStyle = mark.kind === 'change' ? colors.onDesign : colors.designText;
    context.fillText(String(numbers.get(mark.id)), x, y);
  }
  return canvas.toDataURL('image/png');
}
