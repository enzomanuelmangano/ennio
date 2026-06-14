// Random input + clipboard + script handlers. All small, self-
// contained, and route through `dispatch` for inputText so we don't
// duplicate typing logic.

import { createContext, runInContext } from 'node:vm';

import { CommandRegistry } from '../../core/command-registry';
import type { MaestroCommand } from '../../maestro-parser';
import { normalizeSelector } from '../../maestro-parser';
import { interpolate, interpolateSelector } from '../../runner/context';

interface InputRandomTextCmd {
  inputRandomText: true | { length?: number };
}
interface InputRandomNumberCmd {
  inputRandomNumber: true | { length?: number };
}
interface InputRandomEmailCmd {
  inputRandomEmail: true | Record<string, unknown>;
}
interface InputRandomPersonNameCmd {
  inputRandomPersonName: true | Record<string, unknown>;
}
interface PasteTextCmd {
  pasteText: true | Record<string, unknown>;
}
interface CopyTextFromCmd {
  copyTextFrom: unknown;
}
interface EvalScriptCmd {
  evalScript: string;
}
interface AssertTrueCmd {
  assertTrue: string;
}

function has<T extends string>(
  cmd: MaestroCommand,
  key: T,
): cmd is MaestroCommand & Record<T, unknown> {
  return typeof cmd === 'object' && cmd !== null && key in cmd;
}

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const FIRST_NAMES = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank'];
const LAST_NAMES = ['Smith', 'Jones', 'Brown', 'Wilson', 'Taylor', 'Clark'];

function randString(len: number, alphabet: string): string {
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function stripExpressionWrapper(s: string): string {
  return s.startsWith('${') && s.endsWith('}') ? s.slice(2, -1) : s;
}

export function registerRandomInputHandlers(registry: CommandRegistry): void {
  registry.register(
    (c): c is MaestroCommand & InputRandomTextCmd => has(c, 'inputRandomText'),
    async (cmd, { dispatch }) => {
      const arg = cmd.inputRandomText;
      const len =
        typeof arg === 'object' && arg !== null && 'length' in arg ? (arg.length ?? 8) : 8;
      const text = randString(len, LOWER);
      await dispatch({ inputText: text } as MaestroCommand);
    },
  );

  registry.register(
    (c): c is MaestroCommand & InputRandomNumberCmd => has(c, 'inputRandomNumber'),
    async (cmd, { dispatch }) => {
      const arg = cmd.inputRandomNumber;
      const len =
        typeof arg === 'object' && arg !== null && 'length' in arg ? (arg.length ?? 6) : 6;
      const text = randString(len, '0123456789');
      await dispatch({ inputText: text } as MaestroCommand);
    },
  );

  registry.register(
    (c): c is MaestroCommand & InputRandomEmailCmd => has(c, 'inputRandomEmail'),
    async (_cmd, { dispatch }) => {
      const user = randString(8, LOWER);
      await dispatch({ inputText: `${user}@test.com` } as MaestroCommand);
    },
  );

  registry.register(
    (c): c is MaestroCommand & InputRandomPersonNameCmd => has(c, 'inputRandomPersonName'),
    async (_cmd, { dispatch }) => {
      const f = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
      const l = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
      await dispatch({ inputText: `${f} ${l}` } as MaestroCommand);
    },
  );

  registry.register(
    (c): c is MaestroCommand & PasteTextCmd => has(c, 'pasteText'),
    async (_cmd, { ctx, dispatch }) => {
      const text = ctx.platform.system.getClipboard(ctx.udid).trim();
      if (text) await dispatch({ inputText: text } as MaestroCommand);
    },
  );

  registry.register(
    (c): c is MaestroCommand & CopyTextFromCmd => has(c, 'copyTextFrom'),
    async (cmd, { ctx }) => {
      const raw = interpolateSelector(cmd.copyTextFrom, ctx) as Parameters<
        typeof normalizeSelector
      >[0];
      const sel = normalizeSelector(raw);
      const index =
        typeof raw === 'object' && raw && 'index' in raw ? (raw as { index?: number }).index : 0;
      const r = await ctx.client
        .call('get_text', { testID: sel.id, text: sel.text, index: index ?? 0 })
        .catch(() => undefined);
      if (r && r.ok && r.data) {
        const text = String((r.data as { text: string }).text);
        // Expose to flows as ${maestro.copiedText} (Maestro magic var)
        // AND mirror to the device pasteboard so pasteText works too.
        ctx.copiedText = text;
        ctx.platform.system.setClipboard(ctx.udid, text);
      }
    },
  );

  registry.register(
    (c): c is MaestroCommand & EvalScriptCmd => has(c, 'evalScript'),
    async (cmd, { ctx }) => {
      const expr = stripExpressionWrapper(interpolate(String(cmd.evalScript), ctx));
      const vmCtx = createContext({ output: ctx.outputs });
      runInContext(expr, vmCtx, { timeout: 5000 });
    },
  );

  registry.register(
    (c): c is MaestroCommand & AssertTrueCmd => has(c, 'assertTrue'),
    async (cmd, { ctx }) => {
      const expr = stripExpressionWrapper(interpolate(String(cmd.assertTrue), ctx));
      const vmCtx = createContext({ output: ctx.outputs });
      const result = runInContext(expr, vmCtx, { timeout: 5000 });
      if (!result) throw new Error(`assertTrue failed: ${expr}`);
    },
  );
}
