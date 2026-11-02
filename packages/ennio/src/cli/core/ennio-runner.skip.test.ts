import { describe, expect, it } from 'vitest';

import { skippedAfterFailure } from './ennio-runner';

describe('skippedAfterFailure (executionOrder continueOnFailure: false)', () => {
  const groups = [['a', 'b', 'c']];

  it('skips the rest of the failed flow’s ordered group', () => {
    expect(skippedAfterFailure('a', groups)).toEqual(['b', 'c']);
    expect(skippedAfterFailure('c', groups)).toEqual([]);
  });

  it('skips nothing for a flow outside every group', () => {
    expect(skippedAfterFailure('z', groups)).toEqual([]);
  });
});
