import { RemoteLibraryService, parseMegaFolderLink } from './remote-library.service';

const STORAGE_KEY = 'emaki:remote-library:v1';
const LINK = 'https://mega.nz/folder/AbCd1234#xYz-1234567890abcdef';

describe('parseMegaFolderLink', () => {
  it('reads the folder handle and key out of a share link', () => {
    const result = parseMegaFolderLink(LINK, 1_000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.library.handle).toBe('AbCd1234');
    expect(result.library.key).toBe('xYz-1234567890abcdef');
    expect(result.library.addedAt).toBe(1_000);
  });

  it('accepts a link pasted without a scheme', () => {
    const result = parseMegaFolderLink('mega.nz/folder/AbCd1234#xYz-1234567890abcdef');

    expect(result.ok).toBe(true);
  });

  it('takes the innermost folder of a nested share link', () => {
    const result = parseMegaFolderLink(
      'https://mega.nz/folder/Outer111/folder/Inner222#xYz-1234567890abcdef',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.library.handle).toBe('Inner222');
  });

  it('rejects a file link', () => {
    const result = parseMegaFolderLink('https://mega.nz/file/AbCd1234#xYz-1234567890abcdef');

    expect(result.ok).toBe(false);
  });

  it('rejects a folder link with no key', () => {
    const result = parseMegaFolderLink('https://mega.nz/folder/AbCd1234');

    expect(result.ok).toBe(false);
  });

  it('rejects a link from another host', () => {
    const result = parseMegaFolderLink('https://drive.google.com/folder/AbCd1234#xYz-1234567890abcdef');

    expect(result.ok).toBe(false);
  });
});

describe('RemoteLibraryService', () => {
  let service: RemoteLibraryService;

  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    service = new RemoteLibraryService();
  });

  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  it('stores a valid link and reloads it in a later session', () => {
    service.connect(LINK);

    const reopened = new RemoteLibraryService();
    expect(reopened.library()?.handle).toBe('AbCd1234');
    expect(reopened.hasLibrary()).toBe(true);
  });

  it('keeps the previous target when the new link is invalid', () => {
    service.connect(LINK);
    const result = service.connect('https://mega.nz/folder/AbCd1234');

    expect(result.ok).toBe(false);
    expect(service.library()?.handle).toBe('AbCd1234');
  });

  it('clears the target on forget', () => {
    service.connect(LINK);
    service.forget();

    expect(service.library()).toBeNull();
    expect(new RemoteLibraryService().hasLibrary()).toBe(false);
  });
});
