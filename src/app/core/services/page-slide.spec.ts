import {
  clampSlideOffset,
  slideColorProgress,
  slideSettleOffset,
  slideShouldCommit,
  slideSign,
} from './page-slide';

describe('slideSign', () => {
  it('sends the next page left or up, and mirrors horizontal RTL', () => {
    expect(slideSign('next', 'horizontal', false)).toBe(-1);
    expect(slideSign('prev', 'horizontal', false)).toBe(1);
    expect(slideSign('next', 'horizontal', true)).toBe(1);
    expect(slideSign('next', 'vertical', true)).toBe(-1);
    expect(slideSign('prev', 'vertical', false)).toBe(1);
  });
});

describe('clampSlideOffset', () => {
  it('only travels toward the commit side', () => {
    expect(clampSlideOffset(40, -1, 200)).toBe(0);
    expect(clampSlideOffset(-40, -1, 200)).toBe(-40);
    expect(clampSlideOffset(-400, -1, 200)).toBe(-200);
    expect(clampSlideOffset(-10, 1, 200)).toBe(0);
    expect(clampSlideOffset(50, 1, 200)).toBe(50);
  });
});

describe('slideColorProgress', () => {
  it('tracks how far the page has traveled', () => {
    expect(slideColorProgress(0, 200)).toBe(0);
    expect(slideColorProgress(-100, 200)).toBe(0.5);
    expect(slideColorProgress(200, 200)).toBe(1);
    expect(slideColorProgress(-400, 200)).toBe(1);
    expect(slideColorProgress(10, 0)).toBe(0);
  });
});

describe('slideSettleOffset', () => {
  it('moves from the release point toward the settle point', () => {
    expect(slideSettleOffset(-40, -200, 0)).toBe(-40);
    expect(slideSettleOffset(-40, -200, 0.5)).toBe(-120);
    expect(slideSettleOffset(-40, -200, 1)).toBe(-200);
    expect(slideSettleOffset(-40, 0, 1)).toBe(0);
  });
});

describe('slideShouldCommit', () => {
  it('commits a drag released without pulling back', () => {
    expect(slideShouldCommit(-80, -80, -1, 28)).toBeTrue();
  });

  it('commits when the pull-back stays inside the tolerance', () => {
    expect(slideShouldCommit(-60, -80, -1, 28)).toBeTrue();
  });

  it('cancels when the finger pulls back past the tolerance', () => {
    expect(slideShouldCommit(-40, -80, -1, 28)).toBeFalse();
  });

  it('cancels a gesture that never moved', () => {
    expect(slideShouldCommit(0, 0, -1, 28)).toBeFalse();
  });

  it('uses the same rule for a downward or rightward slide', () => {
    expect(slideShouldCommit(80, 100, 1, 28)).toBeTrue();
    expect(slideShouldCommit(50, 100, 1, 28)).toBeFalse();
  });
});
