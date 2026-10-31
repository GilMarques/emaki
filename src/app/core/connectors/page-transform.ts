/**
 * Page transforms for provider images.
 *
 * Some providers serve their pages pre-scrambled: the image is cut into a
 * grid of tiles that are shuffled before delivery. Reading such a page
 * straight from the CDN shows a mosaic, so the tiles have to be put back in
 * order before the page is stored.
 */

/** Transforms that can be applied to a fetched page image. */
export type PageTransform = 'baku';

/** Grid geometry of the "baku" scramble: 4×4 tiles, each a multiple of 8px. */
const DIVIDE_NUM = 4;
const MULTIPLE = 8;

/**
 * Undo the "baku" tile shuffle.
 *
 * The provider splits the page into a 4×4 grid of tiles and transposes that
 * grid before serving it. Reading the tiles back in transposed order
 * restores the original page.
 */
export async function descrambleBaku(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close?.();
    return blob;
  }

  const width = canvas.width;
  const height = canvas.height;
  const cellWidth = Math.floor(width / (DIVIDE_NUM * MULTIPLE)) * MULTIPLE;
  const cellHeight = Math.floor(height / (DIVIDE_NUM * MULTIPLE)) * MULTIPLE;

  // Start from the untouched page so every tile is overwritten in place.
  ctx.drawImage(bitmap, 0, 0, width, height, 0, 0, width, height);
  for (let e = 0; e < DIVIDE_NUM * DIVIDE_NUM; e++) {
    const sourceY = Math.floor(e / DIVIDE_NUM) * cellHeight;
    const sourceX = (e % DIVIDE_NUM) * cellWidth;
    const target = (e % DIVIDE_NUM) * DIVIDE_NUM + Math.floor(e / DIVIDE_NUM);
    const targetX = (target % DIVIDE_NUM) * cellWidth;
    const targetY = Math.floor(target / DIVIDE_NUM) * cellHeight;
    ctx.drawImage(
      bitmap,
      sourceX,
      sourceY,
      cellWidth,
      cellHeight,
      targetX,
      targetY,
      cellWidth,
      cellHeight,
    );
  }
  bitmap.close?.();

  const type = blob.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const encoded = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, type, type === 'image/jpeg' ? 0.92 : undefined),
  );
  return encoded ?? blob;
}

/** Apply a transform to a fetched page image. */
export async function applyPageTransform(blob: Blob, transform: PageTransform): Promise<Blob> {
  switch (transform) {
    case 'baku':
      return descrambleBaku(blob);
    default:
      return blob;
  }
}
