// A live, in-place terminal region: the last N lines of output that get
// rewritten as state changes, with finalized output scrolling above. Pure
// terminal mechanic — no ennio types — so it's reusable and testable with a
// fake stream. Renders are coalesced to ~fps; only emits cursor codes on a TTY.

import { cursor } from './ansi';

export interface OutputStream {
  write(s: string): void;
  isTTY?: boolean;
}

export class LiveRegion {
  private frame: string[] = []; // lines currently on screen
  private desired: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastPaintAt = 0;
  private started = false;

  constructor(
    private readonly out: OutputStream = process.stdout,
    private readonly intervalMs = 50,
    private readonly clock: () => number = Date.now,
  ) {}

  private get tty(): boolean {
    return this.out.isTTY === true;
  }

  /** Set the live region's content. Coalesced; paints at most every intervalMs. */
  render(lines: string[]): void {
    this.desired = lines;
    if (!this.tty) return;
    if (!this.started) {
      this.out.write(cursor.hide);
      this.started = true;
    }
    const elapsed = this.clock() - this.lastPaintAt;
    if (elapsed >= this.intervalMs) {
      this.paint();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.paint(), this.intervalMs - elapsed);
    }
  }

  /** Emit lines permanently above the live region, then repaint it below. */
  printAbove(lines: string[]): void {
    if (!this.tty) {
      if (lines.length) this.out.write(lines.join('\n') + '\n');
      return;
    }
    this.out.write(this.eraseFrame() + (lines.length ? lines.join('\n') + '\n' : ''));
    this.frame = [];
    this.paint();
  }

  /** Erase the live region, optionally print a final block, restore the cursor. */
  stop(final?: string[]): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.tty) {
      if (final?.length) this.out.write(final.join('\n') + '\n');
      return;
    }
    let s = this.eraseFrame();
    if (final?.length) s += final.join('\n') + '\n';
    if (this.started) s += cursor.show;
    this.out.write(s);
    this.frame = [];
    this.started = false;
  }

  private paint(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.tty) return;
    this.out.write(this.eraseFrame() + this.desired.join('\n'));
    this.frame = this.desired.slice();
    this.lastPaintAt = this.clock();
  }

  /** Move to the top of the current frame and clear downward. */
  private eraseFrame(): string {
    if (this.frame.length === 0) return cursor.clearDown;
    return cursor.up(this.frame.length - 1) + cursor.clearDown;
  }
}
