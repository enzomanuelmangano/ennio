import { describe, it, expect } from 'vitest';

import { parseArgs } from './args';

describe('parseArgs boolean flags', () => {
  it('parses --quiet and -q', () => {
    expect(parseArgs(['test', 'e2e/flow.yaml', '--quiet']).flags.quiet).toBe(true);
    expect(parseArgs(['test', 'e2e/flow.yaml', '-q']).flags.quiet).toBe(true);
  });

  it('maps kebab-case --safe-mode to flags.safeMode', () => {
    const r = parseArgs(['test', 'e2e/flow.yaml', '--safe-mode']);
    expect(r.flags.safeMode).toBe(true);
    expect(r.positional).toEqual(['e2e/flow.yaml']);
  });

  it('defaults flags to undefined when not passed', () => {
    const r = parseArgs(['test', 'e2e/flow.yaml']);
    expect(r.flags.quiet).toBeUndefined();
    expect(r.flags.safeMode).toBeUndefined();
  });

  it('composes with other flags', () => {
    const r = parseArgs(['test', 'e2e/', '--safe-mode', '--verbose', '--lenient']);
    expect(r.flags.safeMode).toBe(true);
    expect(r.flags.verbose).toBe(true);
    expect(r.flags.lenient).toBe(true);
  });

  it('parses --in-process-tap as a boolean flag', () => {
    const r = parseArgs(['test', 'e2e/', '--in-process-tap']);
    expect(r.flags.inProcessTap).toBe(true);
    expect(r.positional).toEqual(['e2e/']);
  });

  it('maps kebab flags to camelCase keys (--disable-reuse-app, --disable-animations)', () => {
    const r = parseArgs(['test', 'e2e/', '--disable-reuse-app', '--disable-animations']);
    expect(r.flags.disableReuseApp).toBe(true);
    expect(r.flags.noAnimations).toBe(true);
  });

  it('parses --show-touches as a boolean flag', () => {
    const r = parseArgs(['test', 'e2e/', '--show-touches']);
    expect(r.flags.showTouches).toBe(true);
    expect(r.positional).toEqual(['e2e/']);
  });

  it('drops removed legacy flags (--fast) to positionals', () => {
    const r = parseArgs(['test', 'e2e/', '--fast']);
    expect(r.flags.inProcessTap).toBeUndefined();
    expect(r.positional).toContain('--fast');
  });

  it('surfaces unknown flags as positionals', () => {
    const r = parseArgs(['test', 'e2e/', '--definitely-not-a-flag']);
    expect(r.positional).toContain('--definitely-not-a-flag');
  });
});
