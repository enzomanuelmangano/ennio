// A Reporter that emits nothing. The flow runner needs a reporter for its
// progress callbacks, but `ennio_run_flow` returns the whole outcome as a
// structured FlowResult — there is no console to narrate to. Every event is
// a no-op; the caller reads the returned FlowResult instead.

import type { FlowResult, Reporter, SuiteResult } from './reporter';

export class SilentReporter implements Reporter {
  suiteStart(): void {}
  flowStart(): void {}
  stepPass(): void {}
  stepFail(): void {}
  flowEnd(_result: FlowResult): void {}
  suiteEnd(_result: SuiteResult): void {}
}
