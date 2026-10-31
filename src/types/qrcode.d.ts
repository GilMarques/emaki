/**
 * Minimal typings for the `qrcode` package.
 *
 * The published `@types/qrcode` pulls in the Node type definitions, which
 * would change how `setTimeout` resolves across the whole app — so the two
 * functions we use are declared here instead.
 */
declare module 'qrcode' {
  export interface QRCodeToDataURLOptions {
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    margin?: number;
    width?: number;
    scale?: number;
    color?: { dark?: string; light?: string };
    type?: 'image/png' | 'image/webp';
  }

  const QRCode: {
    toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>;
    toString(text: string, options?: { type?: 'svg' | 'terminal' }): Promise<string>;
  };

  export default QRCode;
}
