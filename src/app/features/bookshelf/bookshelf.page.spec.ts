import { formatBytes } from './bookshelf.page';

describe('formatBytes', () => {
  it('renders bytes below 1 KB', () => {
    expect(formatBytes(512)).toBe('512 B');
  });

  it('renders KB', () => {
    expect(formatBytes(2048)).toBe('2 KB');
  });

  it('renders MB with one decimal below 10', () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
    expect(formatBytes(7_340_032)).toBe('7 MB');
  });

  it('renders GB', () => {
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3 GB');
  });
});