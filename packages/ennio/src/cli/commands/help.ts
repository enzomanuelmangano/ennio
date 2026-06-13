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
  ennio improvise [bundleId]    play the app without a score: autonomous crash hunt, exit 0/1
  ennio clean [bundleId]        wipe ennio's on-screen overlays in the running app
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
  improvise: `ennio improvise [bundleId]

Play the app WITHOUT a score. A YAML flow is sheet music ennio performs
note for note; improvise is ennio exploring on its own — the product is
the exit code, for CI: does the app survive? Walks the app for the
wall-clock budget, prints a one-line summary (plus any warnings) and
writes NO files unless --output is set. (\`smoke\` is a hidden
back-compat alias through the 0.1.0 betas.)

Starts WARM: no relaunch, no state reset — the crawl roots at whatever
screen the app is showing, with session and data intact. Action order
is shuffled from a printed seed so repeated runs probe different paths.
Input is REAL: every tap is a HID touch through the simulator's event
pipeline, and animations run untouched — the app is exercised the way
a user would.

  exit 0   crawl completed (caps and budget cuts are fine)
  exit 1   app crashed mid-crawl (diagnosis printed, last action
           attributed), attach failed, or no screen was readable

bundleId defaults to the app already open on the booted simulator;
several running apps is an error listing the candidates, never a guess.

Options:
  --output DIR       also write crawl artifacts (app-map.json, map.mmd,
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
Environment: ENNIO_UDID, ENNIO_DYLIB_PATH`,
  clean: `ennio clean [bundleId]

Tidy ennio's on-screen overlays (the touch indicators + the "E2E" debug
banner) in the running app. ennio's dylib paints these while a run is
active and normally tears them down on a clean exit — but when a run
aborts (crash, timeout, error) they can stay painted on the still-running
app. This wipes them.

Attaches WARM: it reuses the already-running app and never relaunches or
resets state — the app and its data are left intact (the distinction from
restart-app, which kills and relaunches the process). Only ennio's own
instrumentation is removed.

  exit 0   overlays cleared
  exit 1   attach failed, no app running, several apps (ambiguous), or
           the clear could not be confirmed

bundleId defaults to the app already open on the booted simulator;
several running apps is an error listing the candidates, never a guess.

Options: --android (target an emulator)
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
