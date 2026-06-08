import { describe, it, expect } from 'vitest';

import { LiveRegion, type OutputStream } from './live-region';

function fakeTty() {
  const writes: string[] = [];
  const out: OutputStream = { write: (s) => void writes.push(s), isTTY: true };
  return { out, all: () => writes.join('') };
}

describe('LiveRegion (TTY)', () => {
  it('renders the frame and repaints over the previous one', () => {
    const { out, all } = fakeTty();
    const r = new LiveRegion(out, 0); // intervalMs 0 → paint immediately
    r.render(['a', 'b']);
    expect(all()).toContain('a\nb');
    r.render(['a', 'c']);
    // moved up one line (frame had 2 lines) and cleared down before repaint
    expect(all()).toContain('\x1b[1A');
    expect(all()).toContain('a\nc');
  });

  it('printAbove emits permanent lines then repaints the region', () => {
    const { out, all } = fakeTty();
    const r = new LiveRegion(out, 0);
    r.render(['live']);
    r.printAbove(['DONE flow']);
    expect(all()).toContain('DONE flow\n');
    expect(all().lastIndexOf('live')).toBeGreaterThan(all().indexOf('DONE flow'));
  });

  it('stop clears, writes a final block, restores the cursor', () => {
    const { out, all } = fakeTty();
    const r = new LiveRegion(out, 0);
    r.render(['x']);
    r.stop(['summary']);
    expect(all()).toContain('summary\n');
    expect(all()).toContain('\x1b[?25h'); // show cursor
  });

  it('non-TTY: render is a no-op, printAbove/stop write plainly', () => {
    const writes: string[] = [];
    const out: OutputStream = { write: (s) => void writes.push(s), isTTY: false };
    const r = new LiveRegion(out, 0);
    r.render(['live']);
    expect(writes.join('')).toBe('');
    r.printAbove(['perm']);
    r.stop(['end']);
    expect(writes.join('')).toBe('perm\nend\n');
    expect(writes.join('')).not.toContain('\x1b');
  });
});
