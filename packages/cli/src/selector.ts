/**
 * Selector serialization shared between EnnioClient and NitroWriter.
 *
 * Encodes a Maestro selector for the in-app SelectorParser. Strips
 * undefined keys so the native side parses cleanly. Both writer and
 * client consume this — keeping it in one place avoids the recurring
 * drift the audit flagged.
 */

import type { Selector } from './client';

export function selectorToJson(selector: Selector): string {
  const out: Record<string, unknown> = {};
  if (selector.id !== undefined) out.id = selector.id;
  if (selector.text !== undefined) {
    if (typeof selector.text === 'string') {
      out.text = selector.text;
    } else {
      out.text = selector.text.pattern;
      if (selector.text.mode && selector.text.mode !== 'exact') {
        out.textMatchMode = selector.text.mode;
      }
    }
  }
  if (selector.index !== undefined) out.index = selector.index;
  if (selector.point !== undefined) {
    out.point = typeof selector.point === 'string'
      ? selector.point
      : { x: selector.point.x, y: selector.point.y };
  }
  if (selector.enabled !== undefined) out.enabled = selector.enabled;
  if (selector.checked !== undefined) out.checked = selector.checked;
  if (selector.focused !== undefined) out.focused = selector.focused;
  if (selector.selected !== undefined) out.selected = selector.selected;
  if (selector.below) out.below = JSON.parse(selectorToJson(selector.below));
  if (selector.above) out.above = JSON.parse(selectorToJson(selector.above));
  if (selector.leftOf) out.leftOf = JSON.parse(selectorToJson(selector.leftOf));
  if (selector.rightOf) out.rightOf = JSON.parse(selectorToJson(selector.rightOf));
  if (selector.containsChild) out.containsChild = JSON.parse(selectorToJson(selector.containsChild));
  if (selector.childOf) out.childOf = JSON.parse(selectorToJson(selector.childOf));
  if (selector.containsDescendants) {
    out.containsDescendants = selector.containsDescendants.map((s) => JSON.parse(selectorToJson(s)));
  }
  if (selector.width !== undefined) out.width = selector.width;
  if (selector.height !== undefined) out.height = selector.height;
  if (selector.tolerance !== undefined) out.tolerance = selector.tolerance;
  if (selector.traits) out.traits = selector.traits;
  return JSON.stringify(out);
}
