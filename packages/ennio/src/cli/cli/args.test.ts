import { describe, it, expect } from 'vitest';

import { parseArgs } from './args';

describe('parseArgs --fast', () => {
  it('parses --fast as a boolean flag', () => {
    const r = parseArgs(['test', 'e2e/flow.yaml', '--fast']);
    expect(r.command).toBe('test');
    expect(r.flags.fast).toBe(true);
    expect(r.positional).toEqual(['e2e/flow.yaml']);
  });

  it('defaults fast to undefined when not passed', () => {
    const r = parseArgs(['test', 'e2e/flow.yaml']);
    expect(r.flags.fast).toBeUndefined();
  });

  it('composes with other flags', () => {
    const r = parseArgs(['test', 'e2e/', '--fast', '--verbose', '--lenient']);
    expect(r.flags.fast).toBe(true);
    expect(r.flags.verbose).toBe(true);
    expect(r.flags.lenient).toBe(true);
  });
});
