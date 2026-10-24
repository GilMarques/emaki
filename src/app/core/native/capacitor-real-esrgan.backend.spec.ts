import { toNativeSourcePath } from './capacitor-real-esrgan.backend';

describe('toNativeSourcePath', () => {
  it('unwraps a Capacitor file-server URL to the device path', () => {
    expect(
      toNativeSourcePath('https://localhost/_capacitor_file_/data/user/0/app/files/a.jpg'),
    ).toBe('/data/user/0/app/files/a.jpg');
  });

  it('decodes percent-encoded path segments', () => {
    expect(
      toNativeSourcePath('https://localhost/_capacitor_file_/data/x/My%20Book/001.jpg'),
    ).toBe('/data/x/My Book/001.jpg');
  });

  it('drops query strings and fragments', () => {
    expect(toNativeSourcePath('https://localhost/_capacitor_file_/a/b.jpg?v=2#page')).toBe(
      '/a/b.jpg',
    );
  });

  it('leaves paths and other URI schemes untouched', () => {
    expect(toNativeSourcePath('/storage/emulated/0/a.jpg')).toBe('/storage/emulated/0/a.jpg');
    expect(toNativeSourcePath('file:///data/a.jpg')).toBe('file:///data/a.jpg');
    expect(toNativeSourcePath('content://media/external/images/1')).toBe(
      'content://media/external/images/1',
    );
    expect(toNativeSourcePath('assets/sample/a.jpg')).toBe('assets/sample/a.jpg');
  });
});
