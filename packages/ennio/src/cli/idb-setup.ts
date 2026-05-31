/**
 * idb preflight + opt-in auto-install.
 *
 * ennio drives the simulator through two Facebook `idb` binaries:
 *   - `idb_companion` — the gRPC HID backend every tap/swipe goes through
 *     (see idb-grpc.ts). Installed via Homebrew.
 *   - `idb` — the Python CLI used for app lifecycle (`terminate`,
 *     `uninstall`, `ui describe-all`; see runner/lifecycle.ts). Installed
 *     via pipx / pip as the `fb-idb` package.
 *
 * Historically the user had to install both by hand before ennio would run.
 * This module checks them once at `ennio test` startup and, with the user's
 * consent, installs whatever is missing — so a fresh machine goes from
 * `npm i -g @reactiive/ennio` to a green run without a manual detour.
 *
 * Consent rules (installing software silently is never OK):
 *   - all present                  → no-op.
 *   - interactive TTY              → prompt [Y/n]; default yes.
 *   - ENNIO_AUTO_INSTALL_IDB=1     → install without prompting (setup scripts).
 *   - CI / non-TTY / declined      → DO NOT install; throw with the exact
 *                                    manual commands so the failure is
 *                                    actionable, not a silent hang.
 *
 * The decision logic takes its side effects as injected deps so it is unit
 * testable without touching PATH, Homebrew, or stdin.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

export type IdbStatus = { companion: boolean; cli: boolean };

/** A single thing to install: a human label + the command to run. */
export type InstallStep = { label: string; cmd: string; args: string[] };

export interface IdbDeps {
  platform: NodeJS.Platform;
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
  /** Is `bin` resolvable on PATH? */
  onPath(bin: string): boolean;
  /** Is Homebrew available (needed for idb_companion)? */
  brewAvailable(): boolean;
  /** Is pipx available (preferred installer for the fb-idb CLI)? */
  pipxAvailable(): boolean;
  /** Run an install step; throw on non-zero exit. */
  runInstall(step: InstallStep): void;
  /** Ask a yes/no question; resolve true for yes. */
  confirm(question: string): Promise<boolean>;
  log(msg: string): void;
}

/** Build the ordered install steps for whatever is missing. */
export function planInstall(status: IdbStatus, pipx: boolean): InstallStep[] {
  const steps: InstallStep[] = [];
  if (!status.companion) {
    // Fully-qualified formula auto-taps facebook/fb, no separate tap step.
    steps.push({
      label: 'idb_companion (Homebrew)',
      cmd: 'brew',
      args: ['install', 'facebook/fb/idb-companion'],
    });
  }
  if (!status.cli) {
    steps.push(
      pipx
        ? { label: 'fb-idb (pipx)', cmd: 'pipx', args: ['install', 'fb-idb'] }
        : {
            label: 'fb-idb (pip)',
            cmd: 'python3',
            args: ['-m', 'pip', 'install', '--user', 'fb-idb'],
          },
    );
  }
  return steps;
}

/** Manual instructions, shown when we can't or shouldn't auto-install. */
export function manualInstructions(status: IdbStatus): string {
  const lines = ['idb is required but not fully installed. Install it with:'];
  if (!status.companion) lines.push('  brew install facebook/fb/idb-companion');
  if (!status.cli) lines.push('  pipx install fb-idb   # or: python3 -m pip install fb-idb');
  lines.push('Then re-run. (Set ENNIO_AUTO_INSTALL_IDB=1 to let ennio install it for you.)');
  return lines.join('\n');
}

/**
 * Ensure idb_companion + the idb CLI are available, installing with consent
 * if not. Throws a descriptive error if idb is missing and can't/shouldn't be
 * auto-installed. Pure orchestration over the injected deps.
 */
export async function ensureIdb(deps: IdbDeps): Promise<void> {
  if (deps.env.ENNIO_SKIP_IDB_CHECK) return; // escape hatch for odd setups

  const status: IdbStatus = { companion: deps.onPath('idb_companion'), cli: deps.onPath('idb') };
  if (status.companion && status.cli) return; // nothing to do

  // idb is macOS-only; ennio targets the iOS simulator, so this is really a
  // belt-and-braces guard.
  if (deps.platform !== 'darwin') {
    throw new Error('idb (and the iOS simulator) require macOS.');
  }

  // idb_companion needs Homebrew. No brew → we can't fix it; tell the user.
  if (!status.companion && !deps.brewAvailable()) {
    throw new Error(
      'idb_companion is missing and Homebrew was not found.\n' +
        'Install Homebrew (https://brew.sh) then:\n' +
        manualInstructions(status),
    );
  }

  // Decide consent.
  const force = !!deps.env.ENNIO_AUTO_INSTALL_IDB;
  let approved = force;
  if (!approved) {
    if (!deps.isTTY) {
      // CI / piped: never install unprompted. Fail with the recipe.
      throw new Error(manualInstructions(status));
    }
    const missing = [!status.companion && 'idb_companion', !status.cli && 'idb (fb-idb)']
      .filter(Boolean)
      .join(' + ');
    approved = await deps.confirm(`ennio needs ${missing}. Install it now?`);
  }
  if (!approved) {
    throw new Error('idb install declined.\n' + manualInstructions(status));
  }

  const steps = planInstall(status, deps.pipxAvailable());
  for (const step of steps) {
    deps.log(`Installing ${step.label} …`);
    deps.runInstall(step);
  }

  // Re-verify — an install can "succeed" yet not land on PATH (e.g. pip
  // --user bin dir not in PATH). Surface that clearly rather than failing
  // cryptically at the first tap.
  const after: IdbStatus = { companion: deps.onPath('idb_companion'), cli: deps.onPath('idb') };
  if (!after.companion || !after.cli) {
    throw new Error(
      'idb install ran but the binaries are still not on PATH.\n' +
        'You may need to restart your shell or add the install dir to PATH.\n' +
        manualInstructions(after),
    );
  }
  deps.log('idb ready.');
}

// ---- Real-world deps wiring -------------------------------------------------

function whichOk(bin: string): boolean {
  try {
    execFileSync('which', [bin], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Production dependency bundle for ensureIdb. */
export function defaultIdbDeps(): IdbDeps {
  return {
    platform: process.platform,
    isTTY: !!process.stdout.isTTY && !!process.stdin.isTTY,
    env: process.env,
    onPath: whichOk,
    brewAvailable: () => whichOk('brew'),
    pipxAvailable: () => whichOk('pipx'),
    runInstall: (step) => {
      const r = spawnSync(step.cmd, step.args, { stdio: 'inherit' });
      if (r.status !== 0) {
        throw new Error(`\`${step.cmd} ${step.args.join(' ')}\` failed (exit ${r.status ?? '?'}).`);
      }
    },
    confirm: (question) =>
      new Promise<boolean>((resolveAnswer) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(`${question} [Y/n] `, (answer) => {
          rl.close();
          const a = answer.trim().toLowerCase();
          resolveAnswer(a === '' || a === 'y' || a === 'yes');
        });
      }),
    log: (msg) => console.error(msg),
  };
}
