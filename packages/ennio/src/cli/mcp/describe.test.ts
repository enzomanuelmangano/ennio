import { describe, expect, it } from 'vitest';

import { describeViews, parseDumpViewLine } from './describe';

const screen = { w: 400, h: 800 };

describe('parseDumpViewLine', () => {
  it('parses class, label, value, testID, and button trait', () => {
    expect(
      parseDumpViewLine('RCTView | aL=Following | aV=2 | t= | id=tab-following | tr=b'),
    ).toEqual({
      role: 'RCTView',
      testID: 'tab-following',
      text: 'Following',
      value: '2',
      button: true,
      enabled: true,
    });
  });

  it('falls back to KVC text when no accessibility label is set', () => {
    expect(parseDumpViewLine('RCTTextView | aL= | aV= | t=Hello world | id= | tr=')).toEqual({
      role: 'RCTTextView',
      text: 'Hello world',
      enabled: true,
    });
  });

  it('prefers the accessibility label over KVC text', () => {
    expect(
      parseDumpViewLine('RCTTextView | aL=Greeting | aV= | t=Hello world | id= | tr='),
    ).toEqual({
      role: 'RCTTextView',
      text: 'Greeting',
      enabled: true,
    });
  });

  it('parses legacy three-field lines (older dylibs): t= is text, never a testID', () => {
    expect(parseDumpViewLine('RCTUITextField | aL=Search | aV= | t=')).toEqual({
      role: 'RCTUITextField',
      text: 'Search',
      enabled: true,
    });
    expect(parseDumpViewLine('RCTView | aL= | aV= | t=submit')).toEqual({
      role: 'RCTView',
      text: 'submit',
      enabled: true,
    });
  });

  it('returns null for a line with no identity', () => {
    expect(parseDumpViewLine('RCTView | aL= | aV= | t= | id= | tr=')).toBeNull();
  });

  it('returns null for an empty line', () => {
    expect(parseDumpViewLine('')).toBeNull();
  });

  it('keeps an element identified only by testID', () => {
    expect(parseDumpViewLine('RCTView | aL= | aV= | t= | id=submit | tr=')).toMatchObject({
      role: 'RCTView',
      testID: 'submit',
    });
  });
});

describe('describeViews', () => {
  it('flattens dump_views lines, dropping structural ones', () => {
    const lines = [
      'RCTUITextField | aL=Text input field | aV= | t= | id= | tr=',
      'RCTView | aL= | aV= | t= | id= | tr=',
      'RCTTextView | aL=Feeds | aV= | t= | id=feeds | tr=b',
    ];
    const d = describeViews(lines, screen);
    expect(d.screen).toEqual(screen);
    expect(d.elements).toEqual([
      { role: 'RCTUITextField', text: 'Text input field', enabled: true },
      { role: 'RCTTextView', text: 'Feeds', testID: 'feeds', button: true, enabled: true },
    ]);
  });

  it('returns an empty inventory for no lines', () => {
    expect(describeViews([], screen)).toEqual({ screen, elements: [] });
  });
});
