import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CommandRegistry } from '../core/command-registry';
import type { MaestroCommand } from '../maestro-parser';
import { interpolate, type RunContext } from '../runner/context';

import { registerControlFlowHandlers } from './handlers/control-flow';
import { registerRandomInputHandlers } from './handlers/random-input';

type InputTextCommand = Extract<MaestroCommand, { inputText: unknown }>;

function stubCtx(flowPath: string, flowEnv: Record<string, unknown> = {}): RunContext {
  return {
    flowPath,
    flowEnv,
    outputs: {},
    platform: { name: 'ios' },
  } as RunContext;
}

function dispatchWith(registry: CommandRegistry, ctx: RunContext) {
  const dispatch = async (command: MaestroCommand): Promise<void> =>
    registry.dispatch(command, { ctx, nextCmd: undefined, dispatch });
  return dispatch;
}

describe('script and subflow environment compatibility', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ennio-script-env-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.MAESTRO_ALLOWED;
    delete process.env.SECRET;
  });

  it('evaluates nested commands lazily on every repeat iteration', async () => {
    const ctx = stubCtx(join(dir, 'parent.yaml'), { counter: 0 });
    const registry = new CommandRegistry();
    registerControlFlowHandlers(registry);
    registerRandomInputHandlers(registry);

    const captured: string[] = [];
    registry.register(
      (command): command is InputTextCommand =>
        typeof command === 'object' && command !== null && 'inputText' in command,
      async (command) => {
        captured.push(interpolate(String(command.inputText), ctx));
      },
    );

    await dispatchWith(
      registry,
      ctx,
    )({
      repeat: {
        times: 3,
        commands: [{ evalScript: '${counter += 1}' }, { inputText: '${counter}' }],
      },
    });

    expect(captured).toEqual(['1', '2', '3']);
    expect(ctx.flowEnv?.counter).toBe(3);
  });

  it('supports bare runScript with shared flow globals and a filtered env object', async () => {
    process.env.MAESTRO_ALLOWED = 'visible';
    process.env.SECRET = 'hidden';
    writeFileSync(
      join(dir, 'generated.js'),
      [
        'output.flowValue = FLOW_VALUE;',
        'output.allowed = env.MAESTRO_ALLOWED;',
        'output.secret = env.SECRET;',
        "scriptGlobal = FLOW_VALUE + '-script';",
      ].join('\n'),
      'utf-8',
    );

    const ctx = stubCtx(join(dir, 'parent.yaml'), { FLOW_VALUE: 'parent' });
    const registry = new CommandRegistry();
    registerControlFlowHandlers(registry);

    await dispatchWith(registry, ctx)({ runScript: 'generated.js' });

    expect(ctx.outputs).toEqual({ flowValue: 'parent', allowed: 'visible', secret: undefined });
    expect(ctx.flowEnv?.scriptGlobal).toBe('parent-script');
  });

  it('passes interpolated env into a file subflow and restores the parent scope', async () => {
    writeFileSync(
      join(dir, 'child.yaml'),
      [
        'appId: com.ennio.example',
        'env:',
        '  DEFAULT_VALUE: ${PARENT_VALUE}',
        '---',
        '- evalScript: ${output.callValue = CALL_VALUE}',
        '- evalScript: ${output.defaultValue = DEFAULT_VALUE}',
        "- assertTrue: ${CALL_VALUE === 'parent-child'}",
      ].join('\n'),
      'utf-8',
    );

    const parentEnv = { PARENT_VALUE: 'parent' };
    const ctx = stubCtx(join(dir, 'parent.yaml'), parentEnv);
    const registry = new CommandRegistry();
    registerControlFlowHandlers(registry);
    registerRandomInputHandlers(registry);

    await dispatchWith(
      registry,
      ctx,
    )({
      runFlow: {
        file: 'child.yaml',
        env: { CALL_VALUE: '${PARENT_VALUE + "-child"}' },
      },
    });

    expect(ctx.outputs).toEqual({ callValue: 'parent-child', defaultValue: 'parent' });
    expect(ctx.flowEnv).toBe(parentEnv);
    expect(ctx.flowEnv).toEqual({ PARENT_VALUE: 'parent' });
  });
});
