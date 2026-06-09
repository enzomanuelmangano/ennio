import { describe, expect, it } from 'vitest';

import { describeViews, parseDumpViewLine } from './describe';

const screen = { w: 400, h: 800 };

describe('parseDumpViewLine', () => {
  it('parses class, label, value, and testID', () => {
    expect(parseDumpViewLine('RCTView | aL=Following | aV=2 | t=tab-following')).toEqual({
      role: 'RCTView',
      testID: 'tab-following',
      text: 'Following',
      value: '2',
      enabled: true,
    });
  });

  it('drops empty fields', () => {
    expect(parseDumpViewLine('RCTUITextField | aL=Search | aV= | t=')).toEqual({
      role: 'RCTUITextField',
      text: 'Search',
      enabled: true,
    });
  });

  it('returns null for a line with no identity', () => {
    expect(parseDumpViewLine('RCTView | aL= | aV= | t=')).toBeNull();
  });

  it('returns null for an empty line', () => {
    expect(parseDumpViewLine('')).toBeNull();
  });

  it('keeps an element identified only by testID', () => {
    expect(parseDumpViewLine('RCTView | aL= | aV= | t=submit')).toMatchObject({
      role: 'RCTView',
      testID: 'submit',
    });
  });
});

describe('describeViews', () => {
  it('flattens dump_views lines, dropping structural ones', () => {
    const lines = [
      'RCTUITextField | aL=Text input field | aV= | t=',
      'RCTView | aL= | aV= | t=',
      'RCTTextView | aL=Feeds | aV= | t=feeds',
    ];
    const d = describeViews(lines, screen);
    expect(d.screen).toEqual(screen);
    expect(d.elements).toEqual([
      { role: 'RCTUITextField', text: 'Text input field', enabled: true },
      { role: 'RCTTextView', text: 'Feeds', testID: 'feeds', enabled: true },
    ]);
  });

  it('returns an empty inventory for no lines', () => {
    expect(describeViews([], screen)).toEqual({ screen, elements: [] });
  });
});
