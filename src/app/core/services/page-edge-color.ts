/** Shown until a page has been sampled. */
export const SURROUND_FALLBACK = '#555555';

/**
 * Color of the page margin, sampled from the outer ring of pixels.
 *
 * The median of each channel ignores a few dark marks on the edge, so the
 * letterbox follows the paper rather than a border line or a corner panel.
 * Returns null when the bitmap cannot be read (tainted canvas, no edge pixels).
 */
export function sampleEdgeColor(
  source: CanvasImageSource,
  width: number,
  height: number,
): string | null {
  const maxEdge = 48;
  const longSide = Math.max(width, height, 1);
  const scale = Math.min(1, maxEdge / longSide);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) return null;

  context.drawImage(source, 0, 0, w, h);
  let pixels: Uint8ClampedArray;
  try {
    pixels = context.getImageData(0, 0, w, h).data;
  } catch {
    return null;
  }

  const red: number[] = [];
  const green: number[] = [];
  const blue: number[] = [];
  const push = (x: number, y: number): void => {
    const offset = (y * w + x) * 4;
    if (pixels[offset + 3] < 128) return;
    red.push(pixels[offset]);
    green.push(pixels[offset + 1]);
    blue.push(pixels[offset + 2]);
  };

  for (let x = 0; x < w; x++) {
    push(x, 0);
    if (h > 1) push(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    push(0, y);
    if (w > 1) push(w - 1, y);
  }
  if (red.length === 0) return null;

  return toHex(median(red), median(green), median(blue));
}

/** Average of the page colors currently on screen. Skips pages that failed to sample. */
export function blendEdgeColors(colors: readonly (string | null | undefined)[]): string {
  const parsed = colors
    .map((color) => (color === null || color === undefined ? null : parseHex(color)))
    .filter((color): color is Rgb => color !== null);
  if (parsed.length === 0) return SURROUND_FALLBACK;

  const red = Math.round(parsed.reduce((sum, color) => sum + color.r, 0) / parsed.length);
  const green = Math.round(parsed.reduce((sum, color) => sum + color.g, 0) / parsed.length);
  const blue = Math.round(parsed.reduce((sum, color) => sum + color.b, 0) / parsed.length);
  return toHex(red, green, blue);
}

/**
 * Blend two margin colors by a page-flip completion in `[0, 1]`.
 * `0` is the page still on screen, `1` is the page being revealed.
 */
export function mixHex(from: string, to: string, progress: number): string {
  const start = parseHex(from);
  const end = parseHex(to);
  if (start === null || end === null) return progress >= 1 ? to : from;
  const t = Math.min(1, Math.max(0, progress));
  return toHex(
    Math.round(start.r + (end.r - start.r) * t),
    Math.round(start.g + (end.g - start.g) * t),
    Math.round(start.b + (end.b - start.b) * t),
  );
}

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function toHex(red: number, green: number, blue: number): string {
  return `#${byte(red)}${byte(green)}${byte(blue)}`;
}

function byte(value: number): string {
  return Math.min(255, Math.max(0, value)).toString(16).padStart(2, '0');
}

function parseHex(value: string): Rgb | null {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (match === null) return null;
  const hex = match[1];
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}
