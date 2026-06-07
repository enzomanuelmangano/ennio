/**
 * Minimal argv parser. No commander/yargs — bun is the runtime, deps cost
 * cold-start time. Flags supported are explicit, anything else is positional.
 *
 * Forms accepted:
 *   --flag           → boolean true
 *   --flag=value     → string value
 *   --flag value     → string value (next arg consumed)
 *   -v               → alias for --verbose
 *   -V / --version   → print version
 *   -h / --help      → help flag
 */

export type Flags = {
  port?: number;
  verbose?: boolean;
  trace?: boolean;
  help?: boolean;
  version?: boolean;
  output?: string;
  lenient?: boolean;
  reporter?: string;
  /** --safe-mode: launch with all in-app hooks disabled (ENNIO_SAFE_MODE). */
  safeMode?: boolean;
  /** --quiet / -q: suppress per-step inline output (verbose is the default). */
  quiet?: boolean;
  /** --fast: in-process taps/swipes (dylib activation), per-gesture HID fallback. */
  fast?: boolean;
  /** --no-animations: suppress app animations (ENNIO_NO_ANIMATIONS) for speed. */
  noAnimations?: boolean;
};

export type ParsedArgs = {
  command: string | null;
  positional: string[];
  flags: Flags;
};

const STRING_FLAGS = new Set(['port', 'output', 'reporter']);
const BOOL_FLAGS = new Set([
  'verbose',
  'trace',
  'help',
  'lenient',
  'version',
  'safe-mode',
  'quiet',
  'fast',
  'no-animations',
]);
// kebab-case CLI names → camelCase Flags keys.
const FLAG_KEY_ALIASES: Record<string, string> = {
  'safe-mode': 'safeMode',
  'no-animations': 'noAnimations',
};

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-v') {
      flags.verbose = true;
      continue;
    }
    // -V is the conventional short version flag. -v stays --verbose for
    // back-compat (flows/CI already pass it), so version takes the capital.
    if (a === '-V') {
      flags.version = true;
      continue;
    }
    if (a === '-h') {
      flags.help = true;
      continue;
    }
    if (a === '-q') {
      flags.quiet = true;
      continue;
    }
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    let name: string;
    let val: string | undefined;
    if (eq >= 0) {
      name = a.slice(2, eq);
      val = a.slice(eq + 1);
    } else {
      name = a.slice(2);
      val = undefined;
    }
    if (BOOL_FLAGS.has(name)) {
      (flags as Record<string, unknown>)[FLAG_KEY_ALIASES[name] ?? name] = true;
    } else if (STRING_FLAGS.has(name)) {
      const v = val ?? argv[++i];
      if (name === 'port') flags.port = parseInt(v, 10);
      else (flags as Record<string, unknown>)[name] = v;
    } else {
      // Unknown flag: surface as positional so help can warn — silently
      // dropping makes typos invisible.
      positional.push(a);
    }
  }
  // First positional is the subcommand if it doesn't look like a file path
  // or glob. Heuristic: known command name, or no slash + no .yaml/.yml.
  const KNOWN = new Set(['test', 'run', 'help', 'version', 'hierarchy', 'screenshot', 'doctor']);
  let command: string | null = null;
  if (positional.length > 0 && KNOWN.has(positional[0])) {
    command = positional.shift()!;
  }
  return { command, positional, flags };
}
