import type { Book } from '../models/book.model';

/**
 * Debug-only sample books used when no SAF / file system is wired yet.
 *
 * These point at `src/assets/sample/` paths, which are gitignored — the
 * data lives only on your local machine. When shipping to a real user,
 * gate this behind `environment.production === false` (TODO when we add
 * environments config) or strip it via a build flag.
 *
 * Treat the asset list as best-effort: it lists every file at build time
 * so you don't need to update this constant when you add pages. But that
 * means a missing page silently disappears from the book, so the empty
 * list below is the safe default.
 *
 * To use:
 *   import { SAMPLE_BOOKS, buildHxHChapterOneSample } from './sample-books';
 *   bookstore.openBook(buildHxHChapterOneSample()); // runtime, dev only
 */
export const SAMPLE_BOOKS: readonly Book[] = [];

/**
 * Build a `Book` from the local HxH volume 1, chapter 1 sample folder.
 *
 * Files are listed 01..33. Page index is 0-based; label is the original
 * filename for debugging.
 */
export function buildHxHChapterOneSample(): Book {
  const filenames: readonly string[] = [
    '01.jpg', '02.jpg', '03.jpg', '04.jpg', '05.jpg', '06.jpg', '07.jpg',
    '08.jpg', '09.jpg', '10.jpg', '11.jpg', '12.jpg', '13.jpg', '14.jpg',
    '15.jpg', '16.jpg', '17.jpg', '18.jpg', '19.jpg', '20.jpg', '21.jpg',
    '22.jpg', '23.jpg', '24.jpg', '25.jpg', '26.jpg', '27.jpg', '28.jpg',
    '29.jpg', '30.jpg', '31.jpg', '32.jpg', '33.jpg',
  ];
  const root = 'assets/sample/HxH/Vol.01 Ch.0001 (en) [Nexgear]';
  return {
    id: 'sample:hxh:vol01:ch0001',
    title: 'Hunter × Hunter — Chapter 1 (sample)',
    coverUrl: `${root}/${filenames[0]}`,
    source: { type: 'preset', basePath: root },
    pages: filenames.map((name, index) => ({
      index,
      url: `${root}/${name}`,
      label: name,
    })),
  };
}