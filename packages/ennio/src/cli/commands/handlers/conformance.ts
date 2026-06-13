// `assertScreenConformance` — the structural reward as an e2e gate. Reads the
// live element tree off the running app (dump_views for presence, find_by_testid
// for each element's normalized rect), scores it against a reference manifest,
// records the text report on ctx.outputs (so it surfaces via ${output.X} and the
// run_flow MCP result), and fails the step on a blocker/major finding. The
// report is the reward: a ranked, actionable to-do list — no screenshot needed.

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { PNG } from 'pngjs';

import { CommandRegistry } from '../../core/command-registry';
import { parseDumpViewLine } from '../../mcp/describe';
import type { MaestroCommand } from '../../maestro-parser';
import { scoreConformance } from '../../visual/conformance';
import type { LiveElement, RefManifest } from '../../visual/conformance';
import { captureForMatch } from '../../visual/capture';
import { hex, sampleRegion } from '../../visual/measure';

interface AssertScreenConformanceCmd {
  assertScreenConformance: {
    /** Path to the reference manifest JSON (RefManifest shape). */
    manifest: string;
    /** Lowest severity that fails the step. Default 'major'. */
    failOn?: 'blocker' | 'major' | 'minor';
    /** ctx.outputs key for the result (default 'conformance'). */
    outputVar?: string;
  };
}

function has<T extends string>(
  cmd: MaestroCommand,
  key: T,
): cmd is MaestroCommand & Record<T, unknown> {
  return typeof cmd === 'object' && cmd !== null && key in cmd;
}

const SEV_RANK = { blocker: 0, major: 1, minor: 2 };

export function registerConformanceHandlers(registry: CommandRegistry): void {
  registry.register(
    (c): c is MaestroCommand & AssertScreenConformanceCmd => has(c, 'assertScreenConformance'),
    async (cmd, { ctx }) => {
      const spec = cmd.assertScreenConformance;
      const flowDir = ctx.flowPath ? dirname(ctx.flowPath) : process.cwd();
      const manifestPath = isAbsolute(spec.manifest)
        ? spec.manifest
        : resolve(flowDir, spec.manifest);
      let manifest: RefManifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RefManifest;
      } catch {
        throw new Error(`assertScreenConformance: manifest not found/invalid: ${manifestPath}`);
      }

      // Which testIDs the manifest scopes to (e.g. only chips). We compare
      // against exactly this universe so unrelated elements (containers,
      // buttons) aren't reported as "extra".
      const scoped = new Set(
        manifest.elements.map((e) => e.id).filter((x): x is string => Boolean(x)),
      );

      // 1) Presence: dump_views → the testIDs currently on screen.
      const dump = await ctx.client.call('dump_views');
      const lines = (dump.ok && Array.isArray(dump.data) ? (dump.data as string[]) : []) ?? [];
      const present = new Map<string, string | undefined>(); // testID → text
      for (const line of lines) {
        const el = parseDumpViewLine(line);
        if (el?.testID) present.set(el.testID, el.text);
      }

      // Screen size to normalize find_by_testid (it returns point rects).
      const sz = await ctx.client.call('window_size');
      const screen = (sz.ok && sz.data
        ? (sz.data as { w: number; h: number })
        : { w: 0, h: 0 }) ?? { w: 0, h: 0 };
      const sw = screen.w || 1;
      const sh = screen.h || 1;

      // 2) Geometry: resolve a normalized rect for every in-scope present id.
      const live: LiveElement[] = [];
      for (const id of present.keys()) {
        if (!scoped.has(id)) continue; // only compare the manifest's universe
        const r = await ctx.client.call('find_by_testid', { testID: id });
        if (!r.ok || !r.data) continue;
        const p = r.data as { x: number; y: number; w: number; h: number };
        live.push({
          id,
          role: id.startsWith('tag-') ? 'chip' : undefined,
          text: present.get(id),
          rect: {
            x: +(p.x / sw).toFixed(4),
            y: +(p.y / sh).toFixed(4),
            w: +(p.w / sw).toFixed(4),
            h: +(p.h / sh).toFixed(4),
          },
        });
      }

      // Deterministic color targets: sample the reference frame at each
      // element's rect (sibling <name>.png), and the live screenshot at each
      // live element's rect. The engine emits exact target hex + ΔE.
      const refImgPath = manifestPath.replace(/\.manifest\.json$/, '.png');
      try {
        const refPng = PNG.sync.read(readFileSync(refImgPath));
        for (const el of manifest.elements) {
          if (!el.color) el.color = hex(sampleRegion(refPng, el.rect));
        }
        const { livePng } = await captureForMatch(
          {
            call: (op, args) => ctx.client.call(op, args),
            udid: ctx.udid,
            screenshot: ctx.platform.system.screenshot,
          },
          [],
        );
        const liveImg = PNG.sync.read(livePng);
        for (const el of live) el.color = hex(sampleRegion(liveImg, el.rect));
      } catch {
        /* no ref frame or capture failed → skip color, geometry still scores */
      }

      const result = scoreConformance(live, manifest);
      ctx.outputs[spec.outputVar ?? 'conformance'] = {
        verdict: result.verdict,
        score: result.score,
        dimensions: result.dimensions,
        counts: result.counts,
        findings: result.findings,
      };

      // The report is the reward — always surface it.
      console.log('\n' + result.text + '\n');

      const failOn = spec.failOn ?? 'major';
      const worst = result.findings.reduce(
        (acc, f) => Math.min(acc, SEV_RANK[f.sev]),
        SEV_RANK.minor + 1,
      );
      if (worst <= SEV_RANK[failOn]) {
        throw new Error(
          `assertScreenConformance: ${manifest.name} score ${result.score} — ` +
            `${result.counts.missing} missing, ${result.counts.extra} extra, ` +
            `${result.findings.length} findings (see report above)`,
        );
      }
    },
  );
}
