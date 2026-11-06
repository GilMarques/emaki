import type { ZoomMode } from '../models/settings.model';

/**
 * Where a page image sits inside a screen-sized leaf.
 *
 * Fit to screen contains the image. Fit to width and fit to height use that
 * axis, then stop if the other axis would leave the leaf, so the bitmap is
 * never cropped. The same scale is inlined in the vendored page draw
 * (`emakiImageScale`). Keep the two copies matched.
 */
export function containedImageRect(
  pageWidth: number,
  pageHeight: number,
  imageWidth: number,
  imageHeight: number,
  fit: ZoomMode,
): { x: number; y: number; width: number; height: number } {
  if (pageWidth <= 0 || pageHeight <= 0 || imageWidth <= 0 || imageHeight <= 0) {
    return { x: 0, y: 0, width: Math.max(0, pageWidth), height: Math.max(0, pageHeight) };
  }
  const scale = containedImageScale(pageWidth, pageHeight, imageWidth, imageHeight, fit);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return {
    x: (pageWidth - width) / 2,
    y: (pageHeight - height) / 2,
    width,
    height,
  };
}

/** Largest scale that honors `fit` and still lies inside the leaf. */
export function containedImageScale(
  pageWidth: number,
  pageHeight: number,
  imageWidth: number,
  imageHeight: number,
  fit: ZoomMode,
): number {
  const fitWidth = pageWidth / imageWidth;
  const fitHeight = pageHeight / imageHeight;
  if (fit === 'fit-width') return Math.min(fitWidth, fitHeight);
  if (fit === 'fit-height') return Math.min(fitHeight, fitWidth);
  return Math.min(fitWidth, fitHeight);
}
