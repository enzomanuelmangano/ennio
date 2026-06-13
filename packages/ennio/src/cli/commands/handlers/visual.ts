// Visual-conformance handler — `assertScreenMatches`. Captures the live
// screen, compares it (deterministically) against a reference image, records
// the score on ctx.outputs (so it surfaces via ${output.X} and through the
// run_flow MCP result), writes a diff heatmap when asked, and fails the step
// when the match ratio is below threshold. The reference is just a PNG —
// source-agnostic (Figma export, mock, or a prior baseline).

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { CommandRegistry } from '../../core/command-registry';
import type { MaestroCommand } from '../../maestro-parser';
import { captureForMatch } from '../../visual/capture';
import type { MaskInput } from '../../visual/capture';
import { compareScreens } from '../../visual/compare';

const DEFAULT_PASS_THRESHOLD = 0.97;

interface AssertScreenMatchesCmd {
  assertScreenMatches: {
    reference: string;
    threshold?: number;
    mask?: MaskInput[];
    output?: string;
    /** ctx.outputs key to record the score under (default 'screenMatch'). */
    outputVar?: string;
  };
}

function has<T extends string>(
  cmd: MaestroCommand,
  key: T,
): cmd is MaestroCommand & Record<T, unknown> {
  return typeof cmd === 'object' && cmd !== null && key in cmd;
}

export function registerVisualHandlers(registry: CommandRegistry): void {
  registry.register(
    (c): c is MaestroCommand & AssertScreenMatchesCmd => has(c, 'assertScreenMatches'),
    async (cmd, { ctx }) => {
      const spec = cmd.assertScreenMatches;
      const flowDir = ctx.flowPath ? dirname(ctx.flowPath) : process.cwd();
      const refPath = isAbsolute(spec.reference)
        ? spec.reference
        : resolve(flowDir, spec.reference);
      let refPng: Buffer;
      try {
        refPng = readFileSync(refPath);
      } catch {
        throw new Error(`assertScreenMatches: reference image not found: ${refPath}`);
      }

      const { livePng, masks } = await captureForMatch(
        {
          call: (op, args) => ctx.client.call(op, args),
          udid: ctx.udid,
          screenshot: ctx.platform.system.screenshot,
        },
        spec.mask ?? [],
      );

      const result = compareScreens(livePng, refPng, {
        ...(spec.threshold !== undefined && { passThreshold: spec.threshold }),
        masks,
        emitHeatmap: Boolean(spec.output),
      });

      // Record a JSON-safe summary (drop the heatmap buffer) for ${output.X}
      // and the run_flow result.
      const { heatmap, ...summary } = result;
      ctx.outputs[spec.outputVar ?? 'screenMatch'] = summary;

      if (spec.output && heatmap) {
        const outPath = isAbsolute(spec.output) ? spec.output : resolve(flowDir, spec.output);
        writeFileSync(outPath, heatmap);
      }

      if (!result.passed) {
        const where = spec.output ? ` (heatmap: ${spec.output})` : '';
        throw new Error(
          `assertScreenMatches: matchRatio ${result.matchRatio.toFixed(4)} < ` +
            `${spec.threshold ?? DEFAULT_PASS_THRESHOLD} — ${result.diffPixels}/` +
            `${result.comparedPixels} px differ${where}`,
        );
      }
    },
  );
}
