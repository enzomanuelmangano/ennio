// Reporter barrel + factory.

import { JsonReporter } from './json-reporter';
import { LiveReporter } from './live-reporter';
import { PrettyReporter } from './pretty-reporter';
import type { Reporter } from './reporter';

export type { Reporter, FlowResult, SuiteResult } from './reporter';
export { PrettyReporter } from './pretty-reporter';
export { JsonReporter } from './json-reporter';
export { LiveReporter } from './live-reporter';
export { SilentReporter } from './silent-reporter';

export interface PickReporterOptions {
  kind?: 'pretty' | 'json';
  verbose?: boolean;
}

/**
 * json → machine-readable. Interactive TTY (and not CI) → the live animated
 * view. Everything else (pipes, CI logs, files) → the append-only pretty
 * reporter, which is exactly what those contexts want.
 */
export function pickReporter(opts: PickReporterOptions = {}): Reporter {
  if (opts.kind === 'json') return new JsonReporter();
  if (process.stdout.isTTY && !process.env.CI) return new LiveReporter();
  return new PrettyReporter({ verbose: opts.verbose });
}
