/**
 * Ennio CLI entry — subcommand dispatcher.
 *
 * Architecture (two channels):
 *   - Unix-domain socket (/tmp/ennio-control.sock) to the in-app
 *     libennio dylib: discovery, reads, and settle coordination
 *     (find_by_testid, visible, wait_commit, insert_text, …) via
 *     line-delimited JSON. See socket-client.ts.
 *   - in-house HID: every tap / swipe / long-press is a real
 *     IOHIDEvent at the CoreSimulator level (see hid.ts / ennio-hid.ts).
 *   No XCTest helper, no xcodebuild cold-start, no Metro/CDP.
 *
 * Subcommands live in ./commands. Bare invocation with a yaml/dir/glob
 * routes to `test` for back-compat with the original CLI surface.
 */

import { parseArgs } from './cli/args';
import { runTestCommand } from './commands/test';
import { runHelpCommand } from './commands/help';
import { runVersionCommand } from './commands/version';
import { runHierarchyCommand } from './commands/hierarchy';
import { runScreenshotCommand } from './commands/screenshot';
import { runDoctorCommand } from './commands/doctor';

async function main() {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  // Global --version / -V → print version, exit 0. Checked before the
  // no-args/help short-circuits so `ennio --version` works standalone and
  // takes precedence over any (ignored) trailing command.
  if (flags.version) {
    return runVersionCommand();
  }

  // No args at all → top-level help, exit 0.
  if (!command && positional.length === 0) {
    return runHelpCommand([]);
  }
  // Global --help / -h → top-level help (or per-command if a command given).
  if (flags.help && !command) {
    return runHelpCommand(positional);
  }

  switch (command) {
    case 'help':
      return runHelpCommand(positional);
    case 'version':
      return runVersionCommand();
    case 'hierarchy':
      return runHierarchyCommand(positional, flags);
    case 'screenshot':
      return runScreenshotCommand(positional, flags);
    case 'doctor':
      return runDoctorCommand(positional, flags);
    case 'test':
    case 'run':
      return runTestCommand(positional, flags);
    case null: {
      // Bare yaml/dir/glob — treat as `test`. Guard against typos like
      // `ennio bogus`: a single positional with no path/glob marker is
      // almost certainly a misspelled subcommand, not a file.
      if (positional.length === 1) {
        const a = positional[0];
        const looksFileish =
          a.includes('/') || a.includes('*') || a.endsWith('.yaml') || a.endsWith('.yml');
        if (!looksFileish) {
          console.error(`Unknown command: ${a}\n`);
          runHelpCommand([]);
          return 1;
        }
      }
      return runTestCommand(positional, flags);
    }
    default:
      console.error(`Unknown command: ${command}`);
      runHelpCommand([]);
      return 1;
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
