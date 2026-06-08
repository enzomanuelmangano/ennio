import type { MaestroCommand } from '../maestro-parser';

/**
 * Human-readable one-line command description for the step view.
 *   tapOn: {"id":"foo"}               → tapOn id:foo
 *   assertVisible: {"text":"Welcome"} → assertVisible text:"Welcome"
 *   scrollUntilVisible: {...}         → scrollUntilVisible id:foo ↓
 * Shared by every user-facing reporter so step text reads the same everywhere.
 */
export function formatCommand(cmd: MaestroCommand): string {
  const key = Object.keys(cmd)[0];
  const value = (cmd as Record<string, unknown>)[key];

  if (typeof value === 'string') return `${key} ${JSON.stringify(value)}`;
  if (typeof value === 'boolean') return key;

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof obj.id === 'string') parts.push(`id:${obj.id}`);
    if (typeof obj.text === 'string') parts.push(`text:${JSON.stringify(obj.text)}`);
    if (obj.element && typeof obj.element === 'object') {
      const el = obj.element as Record<string, unknown>;
      if (typeof el.id === 'string') parts.push(`id:${el.id}`);
      if (typeof el.text === 'string') parts.push(`text:${JSON.stringify(el.text)}`);
    }
    if (obj.direction === 'DOWN') parts.push('↓');
    if (obj.direction === 'UP') parts.push('↑');
    if (obj.clearState === true) parts.push('{clearState}');
    return parts.length ? `${key} ${parts.join(' ')}` : `${key} ${JSON.stringify(value)}`;
  }
  return key;
}
