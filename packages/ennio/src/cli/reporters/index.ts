// Reporter barrel + factory.

import { JsonReporter } from './json-reporter';
import { PrettyReporter } from './pretty-reporter';
import type { Reporter } from './reporter';

export type { Reporter, FlowResult, SuiteResult } from './reporter';
export { PrettyReporter } from './pretty-reporter';
export { JsonReporter } from './json-reporter';

export interface PickReporterOptions {
  kind?: 'pretty' | 'json';
  verbose?: boolean;
}

export function pickReporter(opts: PickReporterOptions = {}): Reporter {
  if (opts.kind === 'json') return new JsonReporter();
  return new PrettyReporter({ verbose: opts.verbose });
}
