// Shared condition evaluator for Maestro `when:` predicates and `repeat.while`.
//
// One implementation so per-command `when`, `runFlow.when`, and `repeat.while`
// all agree on semantics. Maestro ANDs every present key in the condition:
//   visible / notVisible — element (not) on screen
//   platform             — runtime backend matches (iOS | Android)
//   true                 — a JS expression evaluates truthy

import { createContext, runInContext } from 'node:vm';

import type { MaestroCondition } from '../maestro-parser';
import { normalizeSelector } from '../maestro-parser';

import { interpolate, type RunContext } from './context';
import { isVisible } from './visibility';

/** Strip a `${ ... }` wrapper so the inner JS is evaluated (mirrors evalScript). */
function stripExpressionWrapper(s: string): string {
  const m = s.match(/^\$\{([\s\S]*)\}$/);
  return m ? m[1] : s;
}

/**
 * Evaluate a Maestro condition. Returns true when every present key holds.
 * A `true:` expression that throws is treated as false (a malformed guard
 * should not run the guarded command).
 */
export async function evaluateCondition(ctx: RunContext, cond: MaestroCondition): Promise<boolean> {
  if (cond.platform != null) {
    if (String(cond.platform).toLowerCase() !== ctx.platform.name) return false;
  }
  if (cond.visible != null) {
    if (!(await isVisible(ctx, normalizeSelector(cond.visible)))) return false;
  }
  if (cond.notVisible != null) {
    if (await isVisible(ctx, normalizeSelector(cond.notVisible))) return false;
  }
  if (cond.true != null) {
    const expr = stripExpressionWrapper(interpolate(String(cond.true), ctx));
    try {
      const vmCtx = createContext({ output: ctx.outputs });
      if (!runInContext(expr, vmCtx, { timeout: 5000 })) return false;
    } catch {
      return false;
    }
  }
  return true;
}
