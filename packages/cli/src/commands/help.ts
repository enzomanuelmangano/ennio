/**
 * `ennio help [command]` — top-level or per-command usage.
 */

const TOPLEVEL = `🧪 Ennio — fast iOS E2E for React Native

Usage:
  ennio <flow.yaml>             run a flow (alias for \`ennio test\`)
  ennio test <yaml | dir>       run flows
  ennio hierarchy               dump the in-app shadow tree as JSON
  ennio screenshot [path]       grab the simulator screen
  ennio doctor                  diagnose simulator + app + WebSocket
  ennio version                 print version
  ennio help [command]          this message, or per-command help

Common options:
  --port=<n>     WebSocket port (default 9876)
  --verbose, -v  detailed command execution
  --trace        emit a trace marker between commands

Environment:
  ENNIO_UDID         pin to a specific simulator UDID
  ENNIO_DEBUG_IDB=1  log idb fallback calls
`;

const PER_COMMAND: Record<string, string> = {
  test: `ennio test <yaml | dir | glob>

Runs Maestro YAML flows against the booted iOS simulator. If the app
isn't running, ennio auto-launches it via the YAML's \`appId\`.

Options: --port, --verbose, --trace`,
  hierarchy: `ennio hierarchy

Dumps the in-app Fabric shadow tree as JSON. Useful for figuring out
which testID to target.

Options: --port`,
  screenshot: `ennio screenshot [path]

Grabs the booted simulator's screen. Defaults to /tmp/ennio-shot.png.`,
  doctor: `ennio doctor

Sanity check: booted sim, app installed, WS reachable.`,
};

export function runHelpCommand(positional: string[]): number {
  const sub = positional[0];
  if (sub && PER_COMMAND[sub]) {
    console.log(PER_COMMAND[sub]);
  } else {
    console.log(TOPLEVEL);
  }
  return 0;
}
