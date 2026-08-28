import { readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = join(here, '..', 'src', 'assets', 'sample');
const OUT = join(here, '..', 'src', 'assets', 'preset-library.json');

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

// Build a nested folder tree from the discovered book directories. Each path
// segment becomes a folder; the deepest segment is a book (isBook: true) and
// carries its page URLs. Folders higher up are plain containers.
async function buildTree(dirs) {
  const root = { id: 'root', name: 'Library', isBook: false, children: [] };

  for (const dir of dirs) {
    const segs = relative(SAMPLE_DIR, dir).split(sep);
    let node = root;
    let pathId = '';
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      pathId = pathId ? `${pathId}/${seg}` : seg;
      const isLeaf = i === segs.length - 1;
      let child = node.children.find((c) => c.id === `folder:${pathId}` || c.id === `preset:${pathId}`);
      if (!child) {
        child = {
          id: isLeaf ? `preset:${pathId}` : `folder:${pathId}`,
          name: seg,
          isBook: isLeaf,
          children: [],
        };
        node.children.push(child);
      }
      node = child;
    }

    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && isImage(e.name))
      .map((e) => join(dir, e.name))
      .sort(naturalCompare);
    if (files.length === 0) continue;

    const rel = relative(SAMPLE_DIR, dir).split(sep).join('/');
    node.imageUrls = files.map((f) => encodeURI(`assets/sample/${rel}/${basename(f)}`));
  }

  // Folders first, then books; alphabetical within each group.
  const sortNode = (n) => {
    n.children.sort((a, b) => {
      if (a.isBook !== b.isBook) return a.isBook ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    n.children.forEach(sortNode);
  };
  sortNode(root);

  return root;
}

async function main() {
  let root = { id: 'root', name: 'Library', isBook: false, children: [] };
  if (existsSync(SAMPLE_DIR)) {
    root = await buildTree(await findImageDirs(SAMPLE_DIR));
  }
  await writeFile(OUT, `${JSON.stringify({ root }, null, 2)}\n`, 'utf8');
  const count = (() => {
    let n = 0;
    const walk = (f) => {
      if (f.isBook) n++;
      f.children.forEach(walk);
    };
    walk(root);
    return n;
  })();
  console.log(`[gen-preset-books] wrote ${count} preset book(s) -> ${OUT}`);
}

main().catch((err) => {
  console.error('[gen-preset-books] failed:', err);
  process.exit(1);
});
