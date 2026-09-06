import { TestBed } from '@angular/core/testing';

import { RealEsrganPluginService } from './real-esrgan.plugin';
import {
  SCAN_ENHANCEMENT_BACKENDS,
  type EnhancePageArgs,
  type ScanEnhancementBackend,
} from './scan-enhancement-backend';
import type {
  EnhancementCapabilities,
  EnhancePageResult,
} from '../models/scan-enhancement.model';

function fakeBackend(
  id: string,
  available: boolean,
): ScanEnhancementBackend & { calls: string[] } {
  return {
    id,
    calls: [],
    isAvailable: () => available,
    async getCapabilities(): Promise<EnhancementCapabilities> {
      this.calls.push('getCapabilities');
      return { available: true, backend: 'vulkan', models: [id], maxDimension: 4096 };
    },
    async enhancePage(_args: EnhancePageArgs): Promise<EnhancePageResult> {
      this.calls.push('enhancePage');
      return { destinationUri: 'out', width: 1, height: 1, model: 'x', scale: 2 };
    },
    async cancelPage(): Promise<{ cancelled: boolean }> {
      this.calls.push('cancelPage');
      return { cancelled: true };
    },
  };
}

describe('RealEsrganPluginService (backend selection)', () => {
  it('reports unavailable when no backend is present (debug web build)', async () => {
    TestBed.configureTestingModule({ providers: [RealEsrganPluginService] });
    const svc = TestBed.inject(RealEsrganPluginService);
    const caps = await svc.getCapabilities();
    expect(caps.available).toBe(false);
    expect(caps.backend).toBe('none');
  });

  it('selects the first registered, available backend and delegates to it', async () => {
    const tauri = fakeBackend('tauri', true);
    TestBed.configureTestingModule({
      providers: [
        RealEsrganPluginService,
        { provide: SCAN_ENHANCEMENT_BACKENDS, useValue: tauri, multi: true },
      ],
    });
    const svc = TestBed.inject(RealEsrganPluginService);

    const caps = await svc.getCapabilities();
    expect(caps.available).toBe(true);
    expect(caps.models).toContain('tauri');
    expect(tauri.calls).toContain('getCapabilities');

    await svc.enhancePage({
      sourceUri: 'a',
      destinationUri: 'b',
      scale: 2,
      model: 'x',
      tileSize: 0,
      denoise: 0,
      jobId: 'j1',
    });
    expect(tauri.calls).toContain('enhancePage');

    await svc.cancelPage('j1');
    expect(tauri.calls).toContain('cancelPage');
  });

  it('ignores registered backends that report unavailable and falls through', async () => {
    const broken = fakeBackend('broken', false);
    TestBed.configureTestingModule({
      providers: [
        RealEsrganPluginService,
        { provide: SCAN_ENHANCEMENT_BACKENDS, useValue: broken, multi: true },
      ],
    });
    const svc = TestBed.inject(RealEsrganPluginService);
    const caps = await svc.getCapabilities();
    // broken is unavailable, no other backend registered → still none.
    expect(caps.available).toBe(false);
    expect(broken.calls).not.toContain('getCapabilities');
  });
});
