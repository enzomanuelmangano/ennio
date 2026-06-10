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
  /** --in-process-tap: actuate taps via in-process activation (dylib), with a
   *  per-gesture real-HID fallback. iOS-only; opt-in. Default actuation is real
   *  HID touches (exercises the full gesture path). (Deprecated alias: --fast.) */
  inProcessTap?: boolean;
  /** --disable-animations: suppress app animations (ENNIO_NO_ANIMATIONS) for
   *  speed. (Deprecated alias: --no-animations.) */
  noAnimations?: boolean;
  /** --disable-reuse-app: force a full relaunch on clearState instead of the
   *  default soft-reset (data wipe + JS reload). Reuse is ON by default. */
  disableReuseApp?: boolean;
  /** --android: target an Android emulator/device via adb. Default: iOS. */
  android?: boolean;
  /** --ios: force the iOS simulator backend (default). */
  ios?: boolean;
  /** --smoke: `ennio doctor --smoke <bundleId>` runs an end-to-end self-test
   *  (inject → socket → read → actuate) against a real app. */
  smoke?: boolean;
  /** `ennio explore` caps — see commands/explore.ts. */
  maxDepth?: string;
  maxNodes?: string;
  maxActions?: string;
  /** --duration: wall-clock budget for the whole crawl in SECONDS
   *  (default 30). */
  duration?: string;
  /** --deny: case-insensitive regex of testIDs `ennio explore` never taps. */
  deny?: string;
  /** --keep-animations: `ennio explore` leaves app animations running
   *  (explore disables them by default for speed — it maps structure). */
  keepAnimations?: boolean;
};

export type ParsedArgs = {
  command: string | null;
  positional: string[];
  flags: Flags;
};

const STRING_FLAGS = new Set([
  'port',
  'output',
  'reporter',
  'max-depth',
  'max-nodes',
  'max-actions',
  'duration',
  'deny',
]);
const BOOL_FLAGS = new Set([
  'verbose',
  'trace',
  'help',
  'lenient',
  'version',
  'safe-mode',
  'quiet',
  'in-process-tap',
  'disable-animations',
  'disable-reuse-app',
  'android',
  'ios',
  'smoke',
  'keep-animations',
]);
// kebab-case CLI names → camelCase Flags keys.
const FLAG_KEY_ALIASES: Record<string, string> = {
  'safe-mode': 'safeMode',
  'max-depth': 'maxDepth',
  'max-nodes': 'maxNodes',
  'max-actions': 'maxActions',
  'keep-animations': 'keepAnimations',
  'in-process-tap': 'inProcessTap',
  'disable-animations': 'noAnimations',
  'disable-reuse-app': 'disableReuseApp',
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
      // Kebab-case names must map through the same alias table as bool
      // flags — writing the raw 'max-depth' key leaves flags.maxDepth
      // undefined and the flag silently dead.
      else (flags as Record<string, unknown>)[FLAG_KEY_ALIASES[name] ?? name] = v;
    } else {
      // Unknown flag: surface as positional so help can warn — silently
      // dropping makes typos invisible.
      positional.push(a);
    }
  }
  // First positional is the subcommand if it doesn't look like a file path
  // or glob. Heuristic: known command name, or no slash + no .yaml/.yml.
  const KNOWN = new Set([
    'test',
    'run',
    'help',
    'version',
    'hierarchy',
    'screenshot',
    'doctor',
    'mcp',
    'explore',
    'smoke',
  ]);
  let command: string | null = null;
  if (positional.length > 0 && KNOWN.has(positional[0])) {
    command = positional.shift()!;
  }
  return { command, positional, flags };
}
