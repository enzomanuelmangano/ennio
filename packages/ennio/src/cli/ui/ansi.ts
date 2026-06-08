// The single source of truth for terminal styling. TTY detection and the
// NO_COLOR / FORCE_COLOR decision live here once; every other module imports
// from this file rather than re-deriving escape codes.

const ESC = '\x1b';

export const isTTY = process.stdout.isTTY === true;
const useColor = !!process.env.FORCE_COLOR || (isTTY && !process.env.NO_COLOR);

function sgr(code: number, s: string): string {
  return useColor ? `${ESC}[${code}m${s}${ESC}[0m` : s;
}

export const green = (s: string): string => sgr(32, s);
export const red = (s: string): string => sgr(31, s);
export const yellow = (s: string): string => sgr(33, s);
export const cyan = (s: string): string => sgr(36, s);
export const dim = (s: string): string => sgr(2, s);
export const bold = (s: string): string => sgr(1, s);

/**
 * OSC-8 hyperlink (iTerm2, VSCode, kitty, WezTerm). Falls back to the label
 * text on non-TTY. Absolute paths become file:// URLs.
 */
export function hyperlink(target: string, label?: string): string {
  if (!isTTY) return label ?? target;
  const url = target.startsWith('/') ? `file://${target}` : target;
  return `${ESC}]8;;${url}${ESC}\\${label ?? target}${ESC}]8;;${ESC}\\`;
}

/** <1s → `42ms`, <60s → `5.2s`, else `2.5m`. */
export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

/** Braille spinner frames; index by a monotonic tick. */
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Cursor / line control. Emit only to a TTY — callers gate on `isTTY`. */
export const cursor = {
  hide: `${ESC}[?25l`,
  show: `${ESC}[?25h`,
  up: (n: number) => (n > 0 ? `${ESC}[${n}A` : ''),
  clearLine: `\r${ESC}[2K`,
  clearDown: `\r${ESC}[0J`, // erase from cursor to end of screen
};

export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\]8;;.*?(\x1b\\|\x07)/g, '') // OSC-8 wrappers
    .replace(/\x1b\[[0-9;]*m/g, ''); // SGR
}

/** Visible column count, ignoring SGR codes + hyperlink wrappers. */
export function visibleWidth(s: string): number {
  return stripAnsi(s).length;
}

/** Truncate to a visible-column budget, marking the cut with `…`. */
export function truncate(s: string, max: number): string {
  if (max <= 0) return '';
  if (visibleWidth(s) <= max) return s;
  return stripAnsi(s).slice(0, max - 1) + '…';
}

/** A rounded box sized to its content; `border` paints the frame only. */
export function box(lines: string[], border: (s: string) => string = dim): string[] {
  const w = Math.max(0, ...lines.map(visibleWidth));
  const bar = '─'.repeat(w + 2);
  const v = border('│');
  const body = lines.map((l) => `${v} ${l}${' '.repeat(w - visibleWidth(l))} ${v}`);
  return [border(`┌${bar}┐`), ...body, border(`└${bar}┘`)];
}
