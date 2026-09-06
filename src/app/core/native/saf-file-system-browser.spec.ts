import { base64ToBytes, toFsEntry } from './saf-file-system-browser';

describe('toFsEntry', () => {
  it('maps a directory entry', () => {
    const e = {
      name: 'Vol 1',
      uri: 'content://tree/child/doc',
      mime: 'vnd.android.document/directory',
      isDirectory: true,
    };
    expect(toFsEntry(e)).toEqual({
      name: 'Vol 1',
      path: 'content://tree/child/doc',
      kind: 'dir',
      isBook: false,
    });
  });

  it('maps an image entry as a page, not a book', () => {
    const e = {
      name: '01.jpg',
      uri: 'content://tree/child/doc/01',
      mime: 'image/jpeg',
      isDirectory: false,
    };
    expect(toFsEntry(e).kind).toBe('image');
    expect(toFsEntry(e).isBook).toBe(false);
  });

  it('maps an archive entry as a book', () => {
    const e = {
      name: 'chapter.cbz',
      uri: 'content://tree/child/doc/chapter',
      mime: 'application/octet-stream',
      isDirectory: false,
    };
    expect(toFsEntry(e).kind).toBe('archive');
    expect(toFsEntry(e).isBook).toBe(true);
  });

  it('maps an unknown file to other', () => {
    const e = {
      name: 'notes.txt',
      uri: 'content://tree/child/doc/notes',
      mime: 'text/plain',
      isDirectory: false,
    };
    expect(toFsEntry(e).kind).toBe('other');
    expect(toFsEntry(e).isBook).toBe(false);
  });
});

describe('base64ToBytes', () => {
  it('decodes base64 back to the original bytes', () => {
    const original = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const b64 = btoa(String.fromCharCode(...original));
    expect([...base64ToBytes(b64)]).toEqual([...original]);
  });
});