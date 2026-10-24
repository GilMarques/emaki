import { dayKey, dayLabel, relativeReadTime } from './history.page';

/** Local-time timestamps so the day boundaries hold in any timezone. */
const NOW = new Date(2026, 9, 24, 15, 0).getTime();
const TODAY_EARLIER = new Date(2026, 9, 24, 11, 30).getTime();
const YESTERDAY = new Date(2026, 9, 23, 20, 0).getTime();
const LAST_WEEK = new Date(2026, 9, 19, 9, 0).getTime();

describe('history page helpers', () => {
  it('keys days by local calendar date', () => {
    expect(dayKey(TODAY_EARLIER)).toBe('2026-10-24');
    expect(dayKey(YESTERDAY)).toBe('2026-10-23');
  });

  it('labels today and yesterday, and falls back to a date', () => {
    expect(dayLabel(NOW, NOW)).toBe('Today');
    expect(dayLabel(TODAY_EARLIER, NOW)).toBe('Today');
    expect(dayLabel(YESTERDAY, NOW)).toBe('Yesterday');

    const older = dayLabel(LAST_WEEK, NOW);
    expect(older).not.toBe('Today');
    expect(older).not.toBe('Yesterday');
    expect(older).toContain('19');
  });

  it('renders relative read times', () => {
    expect(relativeReadTime(NOW - 5_000, NOW)).toBe('Just now');
    expect(relativeReadTime(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(relativeReadTime(TODAY_EARLIER, NOW)).toBe('3h ago');
  });

  it('shows a date instead of "ago" once the day is over', () => {
    const label = relativeReadTime(YESTERDAY, NOW);
    expect(label).not.toContain('ago');
    expect(label).toContain('23');
  });
});
