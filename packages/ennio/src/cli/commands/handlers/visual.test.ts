// assertScreenMatches handler plumbing — reference resolution, capture wiring,
// score recording on ctx.outputs, and fail-on-mismatch. The pixel math itself
// is covered in visual/compare.test.ts; here we drive the handler with a fake
// RunContext whose screenshot writes a known PNG.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { CommandRegistry } from '../../core/command-registry';
import type { DispatchContext } from '../../core/command-registry';
import type { MaestroCommand } from '../../maestro-parser';
import type { RunContext } from '../../runner/context';

import { registerVisualHandlers } from './visual';

function solidPng(w: number, h: number, r: number, g: number, b: number): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

function fakeCtx(opts: {
  screenshotPng: Buffer;
  flowDir: string;
  rect?: { x: number; y: number; w: number; h: number };
}): RunContext {
  return {
    udid: 'UDID',
    flowPath: join(opts.flowDir, 'flow.yaml'),
    outputs: {},
    client: {
      call: async (op: string) => {
        if (op === 'window_size') return { ok: true, data: { w: 100, h: 100 } };
        if (op === 'find_by_testid')
          return opts.rect ? { ok: true, data: opts.rect } : { ok: false };
        return { ok: true, data: {} };
      },
    },
    platform: {
      system: {
        screenshot: (_udid: string, path: string) => writeFileSync(path, opts.screenshotPng),
      },
    },
  } as unknown as RunContext;
}

function dctx(ctx: RunContext): DispatchContext {
  return { ctx, nextCmd: undefined, dispatch: async () => {} };
}

function run(ctx: RunContext, cmd: MaestroCommand): Promise<void> {
  const reg = new CommandRegistry();
  registerVisualHandlers(reg);
  return reg.dispatch(cmd, dctx(ctx));
}

describe('assertScreenMatches handler', () => {
  it('passes when the screen matches the reference; records the score', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ennio-vis-'));
    const ref = join(dir, 'ref.png');
    writeFileSync(ref, solidPng(100, 100, 10, 20, 30));
    const ctx = fakeCtx({ screenshotPng: solidPng(100, 100, 10, 20, 30), flowDir: dir });

    await expect(
      run(ctx, { assertScreenMatches: { reference: 'ref.png' } }),
    ).resolves.toBeUndefined();
    const score = ctx.outputs.screenMatch as { matchRatio: number; passed: boolean };
    expect(score.matchRatio).toBe(1);
    expect(score.passed).toBe(true);
  });

  it('throws when below threshold, but still records the score first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ennio-vis-'));
    writeFileSync(join(dir, 'ref.png'), solidPng(100, 100, 255, 255, 255));
    const ctx = fakeCtx({ screenshotPng: solidPng(100, 100, 0, 0, 0), flowDir: dir });

    await expect(run(ctx, { assertScreenMatches: { reference: 'ref.png' } })).rejects.toThrow(
      /matchRatio/,
    );
    expect((ctx.outputs.screenMatch as { passed: boolean }).passed).toBe(false);
  });

  it('errors clearly when the reference is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ennio-vis-'));
    const ctx = fakeCtx({ screenshotPng: solidPng(10, 10, 0, 0, 0), flowDir: dir });
    await expect(run(ctx, { assertScreenMatches: { reference: 'nope.png' } })).rejects.toThrow(
      /reference image not found/,
    );
  });

  it('resolves a testID mask and excludes it from the comparison', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ennio-vis-'));
    // reference differs from the live shot only in the top-left 10x10 region.
    const live = solidPng(100, 100, 255, 255, 255);
    const ref = new PNG({ width: 100, height: 100 });
    for (let y = 0; y < 100; y++)
      for (let x = 0; x < 100; x++) {
        const i = (y * 100 + x) * 4;
        const dark = x < 10 && y < 10;
        ref.data[i] = ref.data[i + 1] = ref.data[i + 2] = dark ? 0 : 255;
        ref.data[i + 3] = 255;
      }
    writeFileSync(join(dir, 'ref.png'), PNG.sync.write(ref));
    // window_size is 100x100, so a 10x10 px rect masks the differing block.
    const ctx = fakeCtx({ screenshotPng: live, flowDir: dir, rect: { x: 0, y: 0, w: 10, h: 10 } });

    await expect(
      run(ctx, { assertScreenMatches: { reference: 'ref.png', mask: ['clock'] } }),
    ).resolves.toBeUndefined();
    const score = ctx.outputs.screenMatch as { maskedPixels: number; matchRatio: number };
    expect(score.maskedPixels).toBe(100);
    expect(score.matchRatio).toBe(1);
  });

  it('honors a custom outputVar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ennio-vis-'));
    writeFileSync(join(dir, 'ref.png'), solidPng(20, 20, 5, 5, 5));
    const ctx = fakeCtx({ screenshotPng: solidPng(20, 20, 5, 5, 5), flowDir: dir });
    await run(ctx, { assertScreenMatches: { reference: 'ref.png', outputVar: 'checkout' } });
    expect(ctx.outputs.checkout).toBeDefined();
    expect(ctx.outputs.screenMatch).toBeUndefined();
  });
});
