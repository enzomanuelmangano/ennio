// Shared condition evaluator for Maestro `when:` predicates and `repeat.while`.
//
// One implementation so per-command `when`, `runFlow.when`, and `repeat.while`
// all agree on semantics. Maestro ANDs every present key in the condition:
//   visible / notVisible — element (not) on screen
//   platform             — runtime backend matches (iOS | Android)
//   true                 — a JS expression evaluates truthy

import type { MaestroCondition } from '../maestro-parser';
import { normalizeSelector } from '../maestro-parser';

import { evaluateJsExpression, type RunContext } from './context';
import { isVisible } from './visibility';

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
    try {
      if (!evaluateJsExpression(String(cond.true), ctx)) return false;
    } catch {
      return false;
    }
  }
  return true;
}
