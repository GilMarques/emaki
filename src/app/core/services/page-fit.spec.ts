import { containedImageRect, containedImageScale } from './page-fit';

describe('containedImageScale', () => {
  it('fits a landscape image entirely inside a portrait screen', () => {
    const scale = containedImageScale(400, 800, 1600, 800, 'fit-screen');
    expect(scale * 1600).toBeLessThanOrEqual(400);
    expect(scale * 800).toBeLessThanOrEqual(800);
    expect(scale).toBeCloseTo(400 / 1600);
  });

  it('does not let fit-height run past the sides of the screen', () => {
    expect(containedImageScale(400, 800, 1600, 800, 'fit-height')).toBeCloseTo(400 / 1600);
  });

  it('uses the full width when fit-width already fits the height', () => {
    expect(containedImageScale(400, 800, 1600, 800, 'fit-width')).toBeCloseTo(400 / 1600);
  });
});

describe('containedImageRect', () => {
  it('centers the fitted image in the leaf', () => {
    const rect = containedImageRect(400, 800, 1600, 800, 'fit-screen');
    expect(rect.width).toBeCloseTo(400);
    expect(rect.height).toBeCloseTo(200);
    expect(rect.x).toBeCloseTo(0);
    expect(rect.y).toBeCloseTo(300);
  });
});
