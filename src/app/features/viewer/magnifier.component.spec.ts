import { loupeBackgroundPosition, placedPageRect } from './magnifier.component';

describe('placedPageRect', () => {
  const stage = { left: 10, top: 20 };

  it('keeps a centered leaf under the cursor, not the stage corner', () => {
    const rect = placedPageRect(stage, 0, 0, { x: 200, y: 40, width: 600, height: 800 }, 1);
    expect(rect.x).toBe(210);
    expect(rect.y).toBe(60);
    expect(rect.width).toBe(600);
    expect(rect.height).toBe(800);
  });

  it('scales the leaf from the spread origin when the wheel zoom changes', () => {
    const rect = placedPageRect(stage, -100, -50, { x: 200, y: 40, width: 600, height: 800 }, 2);
    expect(rect.x).toBe(10 - 100 + 400);
    expect(rect.y).toBe(20 - 50 + 80);
    expect(rect.width).toBe(1200);
    expect(rect.height).toBe(1600);
  });
});

describe('loupeBackgroundPosition', () => {
  it('puts the source pixel under the pointer at the loupe centre', () => {
    // 1000×2000 image, loupe 400×600, 2×. Pointer at the image centre.
    expect(loupeBackgroundPosition(0.5, 0.5, 1000, 2000, 2, 400, 600)).toBe('-800px -1700px');
  });
});
