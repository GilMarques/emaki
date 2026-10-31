import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';

import type {
  EnhancementBackend,
  EnhancementCapabilities,
  EnhancePageResult,
} from '../models/scan-enhancement.model';
import type { EnhancePageArgs, ScanEnhancementBackend } from './scan-enhancement-backend';

/** The model compiled by `scripts/ncnn_to_onnx.py` from the Android weights. */
const MODEL_ID = 'realesrgan-v2-anime-x2';
/** Bundled next to the app (see `src/assets/models`). */
const MODEL_URL = 'assets/models/realesrgan-anime-x2.onnx';
/** Where `angular.json` copies the onnxruntime-web runtime files. */
const ORT_ASSET_DIR = 'assets/ort/';
/**
 * The runtime is loaded from `assets/` instead of being bundled: esbuild cannot
 * follow onnxruntime-web's `exports` map here (the build resolves modules the
 * classic node way), and a bundled copy ends up importing itself from a
 * `file://` URL inside its wasm proxy worker.
 */
const ORT_BUNDLE = `${ORT_ASSET_DIR}ort.webgpu.bundle.min.mjs`;
/** The network is a 2× upscaler; the factor is baked into the weights. */
const MODEL_SCALE = 2;
/**
 * Extra pixels fed around every tile. The network's receptive field reaches
 * well beyond its 3×3 kernels, so a tile cut flush against the edge shows a
 * seam; upstream Real-ESRGAN uses the same 10 px margin.
 */
const TILE_PAD = 10;

/** The slice of the onnxruntime-web API this backend uses. */
interface OrtTensor {
  readonly data: Float32Array;
  readonly dims: readonly number[];
}
interface OrtSession {
  readonly outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
}
interface OrtModule {
  env: { wasm: { wasmPaths: string; numThreads: number; proxy: boolean } };
  Tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => OrtTensor;
  InferenceSession: {
    create(
      model: ArrayBuffer,
      options?: {
        executionProviders?: readonly string[];
        graphOptimizationLevel?: 'disabled' | 'basic' | 'extended' | 'all';
      },
    ): Promise<OrtSession>;
  };
}
/** Reported to the app: the WASM execution provider is our CPU path. */
type Provider = 'webgpu' | 'wasm';

/**
 * In-browser enhancement through onnxruntime-web.
 *
 * Runs the same Real-ESRGAN anime 2× weights as the Android ncnn plugin, and
 * writes derivatives into the app's web storage (`emaki/_enhanced/…`, i.e.
 * IndexedDB through `@capacitor/filesystem`), which `FilePageService` already
 * knows how to serve as blob URLs.
 *
 * WebGPU is used when the browser exposes an adapter; otherwise the WASM
 * execution provider runs the same graph, much slower but correct, so the
 * feature degrades instead of disappearing. Firefox on Linux has no WebGPU
 * today, which is why the fallback is not optional.
 */
export class WebGpuEsrganBackend implements ScanEnhancementBackend {
  public readonly id = 'webgpu';

  private ort: Promise<OrtModule> | null = null;
  private session: Promise<OrtSession> | null = null;
  private provider: 'webgpu' | 'wasm' | null = null;
  private readonly cancelled = new Set<string>();

  public isAvailable(): boolean {
    if (Capacitor.isNativePlatform()) return false;
    return (
      typeof OffscreenCanvas !== 'undefined' &&
      typeof createImageBitmap === 'function' &&
      typeof ImageData !== 'undefined'
    );
  }

  public async getCapabilities(): Promise<EnhancementCapabilities> {
    const provider: EnhancementBackend = await this.selectProvider() === 'webgpu' ? 'webgpu' : 'cpu';
    return {
      available: true,
      backend: provider,
      models: [MODEL_ID],
      maxDimension: 2048,
    };
  }

  public async enhancePage(args: EnhancePageArgs): Promise<EnhancePageResult> {
    if (args.model !== MODEL_ID) {
      throw fail('unknown-model', `This backend only ships ${MODEL_ID}.`);
    }
    this.cancelled.delete(args.jobId);
    const ort = await this.loadOrt();
    const session = await this.loadSession(ort);

    const bitmap = await this.loadBitmap(args.sourceUri);
    try {
      const width = bitmap.width;
      const height = bitmap.height;
      const source = new OffscreenCanvas(width, height);
      const sourceCtx = source.getContext('2d', { willReadFrequently: true });
      if (sourceCtx === null) throw fail('decode', 'Could not read the page pixels.');
      sourceCtx.drawImage(bitmap, 0, 0);

      const outWidth = width * MODEL_SCALE;
      const outHeight = height * MODEL_SCALE;
      const output = new OffscreenCanvas(outWidth, outHeight);
      const outputCtx = output.getContext('2d');
      if (outputCtx === null) throw fail('encode', 'Could not allocate the output canvas.');

      const tile = Math.max(64, args.tileSize > 0 ? args.tileSize : 256);
      for (let y = 0; y < height; y += tile) {
        for (let x = 0; x < width; x += tile) {
          if (this.cancelled.has(args.jobId)) {
            throw fail('cancelled', 'Cancelled.');
          }
          const tw = Math.min(tile, width - x);
          const th = Math.min(tile, height - y);
          // Feed a padded window so the model never sees a cut edge, then keep
          // only the part that belongs to this tile.
          const px = Math.max(0, x - TILE_PAD);
          const py = Math.max(0, y - TILE_PAD);
          const pw = Math.min(width, x + tw + TILE_PAD) - px;
          const ph = Math.min(height, y + th + TILE_PAD) - py;

          const patch = sourceCtx.getImageData(px, py, pw, ph);
          const input = new ort.Tensor('float32', toNchw(patch), [1, 3, ph, pw]);
          const result = await session.run({ input });
          const outputName = session.outputNames[0];
          const tensor = result[outputName];
          if (tensor === undefined) throw fail('inference', 'The model returned no image.');

          const scaled = tensorToImage(tensor);
          const cropX = (x - px) * MODEL_SCALE;
          const cropY = (y - py) * MODEL_SCALE;
          outputCtx.drawImage(
            scaled,
            cropX,
            cropY,
            tw * MODEL_SCALE,
            th * MODEL_SCALE,
            x * MODEL_SCALE,
            y * MODEL_SCALE,
            tw * MODEL_SCALE,
            th * MODEL_SCALE,
          );
        }
      }

      const encoded = await this.encode(output, outWidth, args.maxOutputWidth, args.outputQuality);
      await Filesystem.writeFile({
        path: args.destinationUri,
        directory: Directory.Data,
        data: encoded.blob,
        recursive: true,
      });
      return {
        destinationUri: args.destinationUri,
        width: encoded.width,
        height: encoded.height,
        model: args.model,
        scale: MODEL_SCALE,
        bytes: encoded.blob.size,
      };
    } finally {
      bitmap.close();
      this.cancelled.delete(args.jobId);
    }
  }

  public async cancelPage(jobId: string): Promise<{ cancelled: boolean }> {
    this.cancelled.add(jobId);
    return { cancelled: true };
  }

  // ─────────────────────────────── Internals ───────────────────────────────

  private async loadOrt(): Promise<OrtModule> {
    if (this.ort === null) {
      const url = new URL(ORT_BUNDLE, document.baseURI).href;
      this.ort = import(/* webpackIgnore: true */ /* @vite-ignore */ url).then((mod) => {
        const ort = mod as OrtModule;
        // Absolute URL: the runtime imports its loader module by specifier,
        // and a relative path is treated as a bare module name.
        ort.env.wasm.wasmPaths = new URL(ORT_ASSET_DIR, document.baseURI).href;
        // Multi-threaded WASM needs cross-origin isolation, which a plain
        // `ng serve` (and most static hosting) does not have.
        ort.env.wasm.numThreads = 1;
        // Inference off the main thread: a tile takes seconds on the WASM
        // provider, and running it inline froze the whole UI.
        ort.env.wasm.proxy = true;
        return ort;
      });
    }
    return this.ort;
  }

  private async selectProvider(): Promise<Provider> {
    if (this.provider !== null) return this.provider;
    let gpu = false;
    try {
      const nav = navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } };
      gpu = nav.gpu !== undefined && (await nav.gpu.requestAdapter()) !== null;
    } catch {
      gpu = false;
    }
    this.provider = gpu ? 'webgpu' : 'wasm';
    return this.provider;
  }

  private async loadSession(ort: OrtModule): Promise<OrtSession> {
    if (this.session === null) {
      const provider = await this.selectProvider();
      this.session = (async () => {
        const response = await fetch(MODEL_URL);
        if (!response.ok) {
          throw fail('model', `Could not load the enhancement model (${response.status}).`);
        }
        const bytes = await response.arrayBuffer();
        return ort.InferenceSession.create(bytes, {
          executionProviders: [provider],
          graphOptimizationLevel: 'all',
        });
      })();
    }
    return this.session;
  }

  /** Decode a page from app storage (`emaki/…`) or from the network. */
  private async loadBitmap(uri: string): Promise<ImageBitmap> {
    if (uri.startsWith('emaki/')) {
      const { data } = await Filesystem.readFile({ path: uri, directory: Directory.Data });
      const blob = typeof data === 'string' ? base64ToBlob(data) : data;
      return createImageBitmap(blob);
    }
    const response = await fetch(uri);
    if (!response.ok) {
      throw fail('decode', `Could not read the page (${response.status}).`);
    }
    return createImageBitmap(await response.blob());
  }

  /** Encode the result, honouring the width cap from the user's settings. */
  private async encode(
    canvas: OffscreenCanvas,
    width: number,
    maxOutputWidth: number,
    quality: number,
  ): Promise<{ blob: Blob; width: number; height: number }> {
    let target = canvas;
    if (maxOutputWidth > 0 && width > maxOutputWidth) {
      const ratio = maxOutputWidth / width;
      target = new OffscreenCanvas(
        Math.round(width * ratio),
        Math.round(canvas.height * ratio),
      );
      const ctx = target.getContext('2d');
      if (ctx === null) throw fail('encode', 'Could not allocate the output canvas.');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(canvas, 0, 0, target.width, target.height);
    }
    const blob = await target.convertToBlob({
      type: 'image/webp',
      quality: Math.min(1, Math.max(0.1, quality / 100)),
    });
    return { blob, width: target.width, height: target.height };
  }
}

/** RGBA pixels → NCHW float tensor in 0..1, the layout the model expects. */
function toNchw(image: ImageData): Float32Array {
  const { width, height, data } = image;
  const plane = width * height;
  const out = new Float32Array(plane * 3);
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    out[i] = data[p] / 255;
    out[plane + i] = data[p + 1] / 255;
    out[plane * 2 + i] = data[p + 2] / 255;
  }
  return out;
}

/** NCHW float tensor in 0..1 → canvas with the pixels as drawn. */
function tensorToImage(tensor: { data: Float32Array; dims: readonly number[] }): OffscreenCanvas {
  const [, , height, width] = tensor.dims;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw fail('encode', 'Could not allocate a tile canvas.');
  const image = ctx.createImageData(width, height);
  const plane = width * height;
  const data = tensor.data;
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    image.data[p] = clamp255(data[i] * 255);
    image.data[p + 1] = clamp255(data[plane + i] * 255);
    image.data[p + 2] = clamp255(data[plane * 2 + i] * 255);
    image.data[p + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function clamp255(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}

function base64ToBlob(base64: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'image/webp' });
}

/** Error with the `kind` the service maps onto its own error states. */
function fail(kind: string, message: string): Error {
  return Object.assign(new Error(message), { kind });
}
