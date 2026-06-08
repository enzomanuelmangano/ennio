import { describe, expect, it } from 'vitest';

import { classifyError, err, fromRpcOutcome, isErrorResult, ok } from './result';

describe('isErrorResult', () => {
  it('is false for ok and for not_found, true for real failures', () => {
    expect(isErrorResult(ok(1))).toBe(false);
    expect(isErrorResult(err('not_found', 'x'))).toBe(false);
    expect(isErrorResult(err('timeout', 'x'))).toBe(true);
    expect(isErrorResult(err('invalid', 'x'))).toBe(true);
    expect(isErrorResult(err('infra', 'x'))).toBe(true);
  });
});

describe('fromRpcOutcome', () => {
  it('maps the RpcOutcome taxonomy onto the MCP envelope', () => {
    expect(fromRpcOutcome({ kind: 'ok', data: 5 })).toEqual({ ok: true, data: 5 });
    expect(fromRpcOutcome({ kind: 'not-found' })).toEqual({
      ok: false,
      error: { kind: 'not_found', message: 'no matching element' },
    });
    const infra = fromRpcOutcome({ kind: 'infra-error', error: new Error('dead') });
    expect(infra).toEqual({ ok: false, error: { kind: 'infra', message: 'dead' } });
  });
});

describe('classifyError', () => {
  it('classifies messages into kinds', () => {
    expect(classifyError(new Error('element not found')).ok).toBe(false);
    expect(
      (classifyError(new Error('element not found')) as { error: { kind: string } }).error.kind,
    ).toBe('not_found');
    expect(
      (classifyError(new Error('assertVisible timed out')) as { error: { kind: string } }).error
        .kind,
    ).toBe('timeout');
    expect(
      (classifyError(new Error('unsupported command: foo')) as { error: { kind: string } }).error
        .kind,
    ).toBe('invalid');
    expect(
      (classifyError(new Error('socket closed')) as { error: { kind: string } }).error.kind,
    ).toBe('infra');
  });
});
