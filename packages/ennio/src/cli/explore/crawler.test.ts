// The crawler against a scripted fake app — a tiny screen graph the fake
// driver simulates, so traversal order, backtracking, caps, and the
// nondeterminism warnings are all assertable without a device.

import { describe, expect, it } from 'vitest';

import type { DescribedElement } from '../mcp/describe';

import { crawl, DEFAULT_LIMITS, enumerateActions } from './crawler';
import type { ExploreAction, ExploreDriver, ExploreLimits } from './types';

const el = (testID: string): DescribedElement => ({ role: 'RCTView', testID, enabled: true });
const txt = (text: string): DescribedElement => ({ role: 'RCTText', text, enabled: true });

/**
 * Scripted app: screens keyed by name, nav edges as `screen.tap[testID]`.
 * `back` pops a real nav stack. The driver records every call.
 */
interface FakeScreen {
  elements: DescribedElement[];
  tap: Record<string, string | 'stay' | 'fail'>;
}

class FakeApp implements ExploreDriver {
  readonly calls: string[] = [];
  private stack: string[] = [];

  constructor(
    private readonly screens: Record<string, FakeScreen>,
    private readonly rootName = 'home',
    /** Screens where `back` misbehaves (modal that swallows back). */
    private readonly backBroken: Set<string> = new Set(),
  ) {}

  private get currentName(): string {
    return this.stack[this.stack.length - 1] ?? this.rootName;
  }

  async relaunch(): Promise<void> {
    this.calls.push('relaunch');
    this.stack = [this.rootName];
  }

  async tap(action: ExploreAction): Promise<{ ok: boolean; detail?: string }> {
    this.calls.push(`tap:${action.key}`);
    const target = this.screens[this.currentName].tap[action.key];
    if (target === 'fail') return { ok: false, detail: 'scripted failure' };
    if (target && target !== 'stay') this.stack.push(target);
    return { ok: true };
  }

  async back(): Promise<void> {
    this.calls.push('back');
    if (this.backBroken.has(this.currentName)) return; // swallowed
    if (this.stack.length > 1) this.stack.pop();
  }

  async describe(): Promise<DescribedElement[]> {
    return this.screens[this.currentName].elements;
  }

  async screenshot(): Promise<void> {
    /* not under test */
  }
}

const LIMITS: ExploreLimits = { ...DEFAULT_LIMITS };

describe('enumerateActions', () => {
  it('keeps document order, dedupes, applies the denylist', () => {
    const actions = enumerateActions(
      [el('b'), el('a'), el('b'), el('logout-btn'), txt('Title')],
      LIMITS,
    );
    expect(actions.map((a) => a.key)).toEqual(['b', 'a']);
  });
});

describe('crawl', () => {
  const app = () =>
    new FakeApp({
      home: {
        elements: [txt('Home'), el('to-products'), el('to-settings')],
        tap: { 'to-products': 'products', 'to-settings': 'settings' },
      },
      products: {
        elements: [txt('Products'), el('product-row'), el('add-to-cart')],
        tap: { 'product-row': 'detail', 'add-to-cart': 'stay' },
      },
      detail: { elements: [txt('Detail'), el('buy-later')], tap: { 'buy-later': 'stay' } },
      settings: { elements: [txt('Settings'), el('toggle-dark')], tap: { 'toggle-dark': 'stay' } },
    });

  it('discovers the full graph depth-first in document order', async () => {
    const result = await crawl(app(), LIMITS);
    expect(result.nodes).toHaveLength(4);
    const navEdges = result.edges.filter((e) => e.kind === 'nav');
    expect(navEdges).toHaveLength(3); // home→products, products→detail, home→settings
    expect(result.warnings).toEqual([]);
  });

  it('is deterministic: two runs produce identical maps', async () => {
    const a = await crawl(app(), LIMITS);
    const b = await crawl(app(), LIMITS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('records state edges as self-loops and error edges without moving', async () => {
    const result = await crawl(app(), LIMITS);
    const state = result.edges.filter((e) => e.kind === 'state');
    expect(state.map((e) => e.action).sort()).toEqual(['add-to-cart', 'buy-later', 'toggle-dark']);
    for (const e of state) expect(e.from).toBe(e.to);
  });

  it('marks failed taps as error edges and continues', async () => {
    const broken = new FakeApp({
      home: { elements: [el('ghost'), el('to-a')], tap: { ghost: 'fail', 'to-a': 'a' } },
      a: { elements: [txt('A')], tap: {} },
    });
    const result = await crawl(broken, LIMITS);
    expect(result.edges.find((e) => e.action === 'ghost')?.kind).toBe('error');
    expect(result.nodes).toHaveLength(2);
  });

  it('recovers via clearState replay when back is swallowed, with a warning', async () => {
    const fake = new FakeApp(
      {
        home: { elements: [el('open-modal')], tap: { 'open-modal': 'modal' } },
        modal: { elements: [txt('Modal'), el('noop')], tap: { noop: 'stay' } },
      },
      'home',
      new Set(['modal']),
    );
    const result = await crawl(fake, LIMITS);
    expect(result.warnings.some((w) => w.kind === 'back-failed')).toBe(true);
    // Replay = relaunch beyond the initial one.
    expect(fake.calls.filter((c) => c === 'relaunch').length).toBeGreaterThan(1);
    expect(result.nodes).toHaveLength(2);
  });

  it('honors maxDepth and surfaces the cut as a warning', async () => {
    const chain = new FakeApp({
      home: { elements: [el('next-0')], tap: { 'next-0': 's1' } },
      s1: { elements: [txt('S1'), el('next-1')], tap: { 'next-1': 's2' } },
      s2: { elements: [txt('S2'), el('next-2')], tap: { 'next-2': 's3' } },
      s3: { elements: [txt('S3'), el('next-3')], tap: { 'next-3': 'home' } },
    });
    const result = await crawl(chain, { ...LIMITS, maxDepth: 1 });
    expect(result.warnings.some((w) => w.kind === 'cap-hit' && w.detail.includes('maxDepth'))).toBe(
      true,
    );
    expect(result.nodes.length).toBeLessThanOrEqual(3);
  });

  it('seeded shuffle: same seed reproduces the crawl, seeds vary the order', async () => {
    const a = await crawl(app(), { ...LIMITS, seed: 7 });
    const b = await crawl(app(), { ...LIMITS, seed: 7 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // A different seed walks the same graph (node/edge SETS match)…
    const c = await crawl(app(), { ...LIMITS, seed: 1234 });
    expect(c.nodes.map((n) => n.sig).sort()).toEqual(a.nodes.map((n) => n.sig).sort());
    // …but in a different action order somewhere (seeds 7 vs 1234 differ
    // on this fixture; a collision would mean the PRNG ignored the seed).
    expect(JSON.stringify(c.nodes.map((n) => n.actions))).not.toBe(
      JSON.stringify(a.nodes.map((n) => n.actions)),
    );
  });

  it('honors the wall-clock budget as the global stop', async () => {
    // Zero budget: the deadline is already past when the loop starts, so
    // no action fires and the cut is surfaced as a warning.
    const result = await crawl(app(), { ...LIMITS, maxMs: 0 });
    expect(result.steps).toBe(0);
    expect(result.warnings.some((w) => w.kind === 'cap-hit' && w.detail.includes('maxMs'))).toBe(
      true,
    );
  });
});
