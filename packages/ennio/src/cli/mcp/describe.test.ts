import { describe, expect, it } from 'vitest';

import { describeTree } from './describe';

const screen = { w: 400, h: 800 };

describe('describeTree', () => {
  it('flattens nodes with an identity and normalizes rects to [0,1]', () => {
    const raw = JSON.stringify({
      role: 'window',
      frame: { x: 0, y: 0, width: 400, height: 800 },
      children: [
        {
          testID: 'login',
          label: 'Log in',
          enabled: true,
          frame: { x: 100, y: 400, width: 200, height: 40 },
          traits: ['button'],
        },
      ],
    });
    const d = describeTree(raw, screen);
    expect(d.screen).toEqual(screen);
    const login = d.elements.find((e) => e.testID === 'login')!;
    expect(login).toMatchObject({ testID: 'login', text: 'Log in', enabled: true });
    expect(login.rect).toEqual({ x: 0.25, y: 0.5, w: 0.5, h: 0.05 });
  });

  it('drops structural nodes that have neither testID nor text', () => {
    const raw = JSON.stringify({
      frame: { x: 0, y: 0, w: 400, h: 800 },
      subviews: [
        { frame: { x: 0, y: 0, w: 10, h: 10 } },
        { text: 'hi', frame: { x: 0, y: 0, w: 10, h: 10 } },
      ],
    });
    const d = describeTree(raw, screen);
    expect(d.elements).toHaveLength(1);
    expect(d.elements[0].text).toBe('hi');
  });

  it('tolerates alternate field spellings (accessibilityIdentifier / bounds / nodes)', () => {
    const raw = JSON.stringify({
      nodes: [
        {
          accessibilityIdentifier: 'x',
          accessibilityLabel: 'X',
          bounds: { x: 0, y: 0, width: 40, height: 40 },
        },
      ],
    });
    const d = describeTree(raw, screen);
    expect(d.elements[0]).toMatchObject({ testID: 'x', text: 'X' });
  });

  it('defaults enabled to true and honors enabled:false', () => {
    const raw = JSON.stringify([
      { id: 'a', frame: { x: 0, y: 0, w: 1, h: 1 } },
      { id: 'b', enabled: false, frame: { x: 0, y: 0, w: 1, h: 1 } },
    ]);
    const d = describeTree(raw, screen);
    expect(d.elements.find((e) => e.testID === 'a')!.enabled).toBe(true);
    expect(d.elements.find((e) => e.testID === 'b')!.enabled).toBe(false);
  });

  it('returns an empty list for an unparseable snapshot', () => {
    expect(describeTree('not json', screen)).toEqual({ screen, elements: [] });
    expect(describeTree('', screen)).toEqual({ screen, elements: [] });
  });
});
