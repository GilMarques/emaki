import { Injectable } from '@angular/core';

/**
 * QR codes for device pairing.
 *
 * Two directions, because a browser cannot listen on a socket:
 *  - the phone (receiver) *encodes* its pairing payload into a QR the computer
 *    scans with its camera;
 *  - the computer *decodes* it (and can also accept a pasted code).
 *
 * Both libraries are CommonJS, so they are imported dynamically — that keeps
 * them out of the main bundle (and out of the app on platforms that never
 * pair a device).
 */
@Injectable({ providedIn: 'root' })
export class QrService {
  /** Render a pairing payload as a PNG data URL. */
  public async encode(text: string): Promise<string> {
    const { default: QRCode } = await import('qrcode');
    return QRCode.toDataURL(text, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
      color: { dark: '#101014', light: '#ffffff' },
    });
  }

  /**
   * Scan a QR code with the camera.
   *
   * Resolves with the decoded text, or rejects when the user closes the
   * scanner. The camera stream is always stopped again.
   */
  public async scan(video: HTMLVideoElement): Promise<string> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser cannot use the camera.');
    }
    const { default: jsQR } = await import('jsqr');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
    });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('Could not prepare the camera.');
    }

    try {
      video.srcObject = stream;
      video.setAttribute('playsinline', 'true');
      await video.play();

      return await new Promise<string>((resolve, reject) => {
        let settled = false;
        const finish = (value: string | Error) => {
          if (settled) return;
          settled = true;
          stream.getTracks().forEach((t) => t.stop());
          video.srcObject = null;
          if (value instanceof Error) reject(value);
          else resolve(value);
        };

        const tick = () => {
          if (settled) return;
          if (video.readyState === video.HAVE_ENOUGH_DATA) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const image = context.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(image.data, image.width, image.height);
            if (code?.data) {
              finish(code.data);
              return;
            }
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      throw err;
    }
  }
}
