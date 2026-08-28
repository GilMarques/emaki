import { readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = join(here, '..', 'src', 'assets', 'sample');
const OUT = join(here, '..', 'src', 'assets', 'preset-books.json');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff', '.tif']);

// Natural-order sort so `2` comes before `10` regardless of zero-padding.
function naturalCompare(a, b) {
  const ax = [];
  const bx = [];
  a.replace(/(\d+)|(\D+)/g, (_m, n, s) => {
    ax.push([n ? parseInt(n, 10) : Infinity, s ?? '']);
    return '';
  });
  b.replace(/(\d+)|(\D+)/g, (_m, n, s) => {
    bx.push([n ? parseInt(n, 10) : Infinity, s ?? '']);
    return '';
  });
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const an = ax[i] ?? [Infinity, ''];
    const bn = bx[i] ?? [Infinity, ''];
    if (an[0] !== bn[0]) return an[0] - bn[0];
    if (an[1] < bn[1]) return -1;
    if (an[1] > bn[1]) return 1;
  }
  return 0;
}

function isImage(name) {
  return IMAGE_EXT.has(extname(name).toLowerCase());
}

// Every directory that directly contains ≥1 image file is a "book"
// (matches the rule: a folder of images = a book). Series folders that only
// hold volume subfolders are not registered themselves.
async function findImageDirs(root) {
  const out = [];
  async function rec(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && isImage(e.name))) out.push(dir);
    for (const e of entries) {
      if (e.isDirectory()) await rec(join(dir, e.name));
    }
  }
  await rec(root);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function main() {
  const books = [];
  if (existsSync(SAMPLE_DIR)) {
    for (const dir of await findImageDirs(SAMPLE_DIR)) {
      const entries = await readdir(dir, { withFileTypes: true });
      const files = entries
        .filter((e) => e.isFile() && isImage(e.name))
        .map((e) => join(dir, e.name))
        .sort(naturalCompare);
      if (files.length === 0) continue;

      const rel = relative(SAMPLE_DIR, dir).split(sep).join('/');
      const imageUrls = files.map((f) => encodeURI(`assets/sample/${rel}/${basename(f)}`));
      books.push({ id: `preset:${rel}`, title: basename(dir), imageUrls });
    }
  }
  await writeFile(OUT, `${JSON.stringify({ books }, null, 2)}\n`, 'utf8');
  console.log(`[gen-preset-books] wrote ${books.length} preset book(s) -> ${OUT}`);
}

main().catch((err) => {
  console.error('[gen-preset-books] failed:', err);
  process.exit(1);
});
