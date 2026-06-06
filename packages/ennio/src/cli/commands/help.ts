/**
 * `ennio help [command]` — top-level or per-command usage.
 */

const TOPLEVEL = `🧪 Ennio — fast iOS E2E for React Native

Usage:
  ennio <flow.yaml>             run a flow (alias for \`ennio test\`)
  ennio test <yaml | dir>       run flows
  ennio hierarchy               dump the in-app shadow tree as JSON
  ennio screenshot [path]       grab the simulator screen
  ennio doctor                  diagnose Node, Xcode, enniohid, dylib + app socket
  ennio version                 print version
  ennio help [command]          this message, or per-command help

Common options:
  --version, -V  print version and exit
  --verbose, -v  detailed command execution (on by default)
  --quiet, -q    suppress per-step output
  --trace        emit a trace marker between commands

Environment:
  ENNIO_UDID         pin to a specific simulator UDID
  ENNIO_PHASE_TRACE=1  log per-gesture HID + phase timing
`;

const PER_COMMAND: Record<string, string> = {
  test: `ennio test <yaml | dir | glob>

Runs Maestro YAML flows against the booted iOS simulator. If the app
isn't running, ennio auto-launches it via the YAML's \`appId\`.

Options: --port, --verbose (default), --quiet, --trace`,
  hierarchy: `ennio hierarchy

Dumps the in-app Fabric shadow tree as JSON. Useful for figuring out
which testID to target.

Options: --port`,
  screenshot: `ennio screenshot [path]

Grabs the booted simulator's screen. Defaults to /tmp/ennio-shot.png.`,
  doctor: `ennio doctor

Pre-flight check. FAIL rows block a run (Node ≥ 18, Xcode/simctl, enniohid,
libennio.dylib); WARN rows don't (booted sim, app socket). Exit 1 on any FAIL.`,
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
