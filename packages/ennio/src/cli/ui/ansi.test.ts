import { describe, it, expect } from 'vitest';

import { box, fmtMs, stripAnsi, truncate, visibleWidth } from './ansi';

describe('fmtMs', () => {
  it('formats by magnitude', () => {
    expect(fmtMs(500)).toBe('500ms');
    expect(fmtMs(5200)).toBe('5.2s');
    expect(fmtMs(125_000)).toBe('2.1m');
  });
});

describe('stripAnsi / visibleWidth', () => {
  it('ignores SGR codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
    expect(visibleWidth('\x1b[1m\x1b[36mhi\x1b[0m')).toBe(2);
  });
  it('ignores OSC-8 hyperlink wrappers', () => {
    const link = `\x1b]8;;file:///x\x1b\\label\x1b]8;;\x1b\\`;
    expect(stripAnsi(link)).toBe('label');
  });
});

describe('truncate', () => {
  it('marks the cut with … and respects the budget', () => {
    const t = truncate('hello world', 5);
    expect(visibleWidth(t)).toBe(5);
    expect(t.endsWith('…')).toBe(true);
  });
  it('leaves short strings untouched', () => {
    expect(truncate('hi', 10)).toBe('hi');
  });
});

describe('box', () => {
  it('frames content to a uniform width', () => {
    const lines = box(['ab', 'abcd']);
    expect(lines).toHaveLength(4); // top + 2 body + bottom
    const widths = new Set(lines.map(visibleWidth));
    expect(widths.size).toBe(1); // all equal width
  });
});
