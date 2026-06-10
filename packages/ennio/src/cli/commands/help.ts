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
  ennio mcp                     serve ennio over MCP (stdio) for an AI agent
  ennio explore <bundleId>      deterministic DFS app crawl -> app-map.json
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
  mcp: `ennio mcp

Serves ennio as a Model Context Protocol (MCP) server over stdio, so any
MCP client (Claude Code, Cursor, Cline, a custom agent) can drive a device:
read the screen with ennio_describe, then act with ennio_tap / ennio_swipe /
ennio_input_text. Taps and swipes go through the HID driver — ennio is the
tap path. stdout carries only JSON-RPC; diagnostics go to stderr.

Options: --android (target an emulator), --in-process-tap
Environment: ENNIO_UDID, ENNIO_DYLIB_PATH`,
  explore: `ennio explore <bundleId>

Deterministic app crawler: walks the app depth-first, tapping testID'd
elements in document order. Screens are identified by a structural
signature (testIDs + roles, volatile text/numbers normalized), so two
runs over the same build produce the same map. Backtracking is verified:
back first, clearState + path replay on mismatch — nondeterminism is
recorded as a warning, never absorbed.

Writes to .ennio/explore/<bundleId>/ (override with --output):
  app-map.json    sorted, diffable graph: nodes, edges, warnings
  map.mmd         mermaid rendering of the nav edges
  screens/*.png   one screenshot per discovered screen

Options:
  --max-depth N      path-length cap from the root (default 5)
  --max-nodes N      distinct-screen cap (default 50)
  --max-actions N    actions attempted per screen (default 25)
  --max-steps N      global action cap (default 400)
  --max-ms N         wall-clock budget for the crawl (default 30000)
  --deny REGEX       testIDs never tapped (default blocks logout/delete/
                     purchase-looking ids)
  --keep-animations  leave app animations running (explore snaps them
                     to the final frame by default, for speed)
  --reporter json    also print the map to stdout
Environment: ENNIO_UDID, ENNIO_DYLIB_PATH`,
  doctor: `ennio doctor [--smoke <bundleId>]

Pre-flight check. FAIL rows block a run (Node ≥ 18, Xcode/simctl, enniohid,
libennio.dylib); WARN rows don't (booted sim, app socket). Exit 1 on any FAIL.

--smoke <bundleId>  End-to-end self-test against a real app: inject the dylib,
                    bring the socket to bootstrap-ready, read the in-process
                    view tree, and warm the HID actuator. Pass = ennio works on
                    this machine. Run it once after install.`,
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
