import { blendEdgeColors, mixHex, sampleEdgeColor } from './page-edge-color';

describe('sampleEdgeColor', () => {
  function paint(
    width: number,
    height: number,
    fill: (context: CanvasRenderingContext2D) => void,
  ): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('canvas 2d unavailable');
    fill(context);
    return canvas;
  }

  it('returns the paper color of a flat page', () => {
    const page = paint(40, 60, (context) => {
      context.fillStyle = '#f4ecd8';
      context.fillRect(0, 0, 40, 60);
    });

    expect(sampleEdgeColor(page, 40, 60)).toBe('#f4ecd8');
  });

  it('follows the margin and ignores the art in the middle', () => {
    const page = paint(48, 48, (context) => {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, 48, 48);
      context.fillStyle = '#101820';
      context.fillRect(8, 8, 32, 32);
    });

    expect(sampleEdgeColor(page, 48, 48)).toBe('#ffffff');
  });

  it('returns null when the margin is transparent', () => {
    const page = paint(24, 24, () => {
      /* leave the bitmap empty */
    });

    expect(sampleEdgeColor(page, 24, 24)).toBeNull();
  });
});

describe('blendEdgeColors', () => {
  it('averages the pages on screen and skips ones that failed to sample', () => {
    expect(blendEdgeColors(['#000000', null, '#ffffff'])).toBe('#808080');
  });

  it('falls back when nothing was sampled', () => {
    expect(blendEdgeColors([null, undefined])).toBe('#555555');
  });
});

describe('mixHex', () => {
  it('follows page-flip completion from the current margin to the next', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
  });

  it('clamps progress outside the flip', () => {
    expect(mixHex('#000000', '#ffffff', -0.2)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 1.4)).toBe('#ffffff');
  });
});
