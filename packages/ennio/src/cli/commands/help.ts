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
  ennio smoke [bundleId]        crawl-based smoke test: exit 0/1, no artifacts
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
  --duration N       wall-clock budget for the crawl in seconds (default 30)
  --seed N           shuffle per-screen action order (PRNG seed; same
                     seed + same build = same crawl). Default: document
                     order, for diffable maps
  --deny REGEX       testIDs never tapped (default blocks logout/delete/
                     purchase-looking ids)
  --keep-animations  leave app animations running (explore snaps them
                     to the final frame by default, for speed)
  --reporter json    also print the map to stdout
Environment: ENNIO_UDID, ENNIO_DYLIB_PATH`,
  smoke: `ennio smoke [bundleId]

Crawl-based smoke test — same engine as \`ennio explore\`, but the
product is the exit code, for CI: does the app survive autonomous
exploration? Walks the app for the wall-clock budget, prints a one-line
summary (plus any warnings) and writes NO files unless --output is set.

Starts WARM: no relaunch, no state reset — the crawl roots at whatever
screen the app is showing, with session and data intact. Action order
is shuffled from a printed seed so repeated runs probe different paths.

  exit 0   crawl completed (caps and budget cuts are fine)
  exit 1   app crashed mid-crawl (diagnosis printed, last action
           attributed), attach failed, or no screen was readable

bundleId defaults to the app already open on the booted simulator;
several running apps is an error listing the candidates, never a guess.

Not \`ennio doctor --smoke\`, which self-tests ennio's own plumbing —
\`ennio smoke\` tests YOUR app.

Options:
  --output DIR       also write explore artifacts (app-map.json, map.mmd,
                     screenshots) to DIR
  --verbose          stream per-action progress while crawling
  --max-depth N      path-length cap from the root (default 5)
  --max-nodes N      distinct-screen cap (default 50)
  --duration N       wall-clock budget for the crawl in seconds (default 30)
  --seed N           pin the action-order shuffle for an exact replay.
                     Default: a fresh random seed each run (printed in
                     the summary) so CI keeps probing different paths
  --relaunch         restart the app before crawling (app data is kept;
                     default off — the crawl starts on the current screen)
  --deny REGEX       testIDs never tapped (default blocks logout/delete/
                     purchase-looking ids)
  --keep-animations  leave app animations running
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
