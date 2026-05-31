// SettleEngine — the façade commands call instead of inlining wait
// sequences. `settle.run('afterTap', input)` keeps command bodies
// declarative ("tap, then settle as after-a-tap") and lets tests stub
// the engine to assert which policy a command chose.

import type { TypedRpcClient } from '../rpc/client';

import * as policies from './policies';
import type { SettleInput } from './policies';

export type { SettleInput };

export type PolicyName =
  | 'preTapTransition'
  | 'preTapTextDismiss'
  | 'afterTap'
  | 'afterFocus'
  | 'repeatTapGap'
  | 'afterTextInput'
  | 'afterPressKey'
  | 'afterNav'
  | 'afterHideKeyboard'
  | 'preSwipe'
  | 'afterSwipe'
  | 'afterLaunch';

export interface SettleEngine {
  run(policy: PolicyName, input?: SettleInput): Promise<void>;
}

export class RpcSettleEngine implements SettleEngine {
  constructor(private readonly rpc: TypedRpcClient) {}

  run(policy: PolicyName, input: SettleInput = {}): Promise<void> {
    const rpc = this.rpc;
    switch (policy) {
      case 'preTapTransition':
        return policies.preTapTransition(rpc);
      case 'preTapTextDismiss':
        return policies.preTapTextDismiss(rpc);
      case 'afterTap':
        return policies.afterTap(rpc, input);
      case 'afterFocus':
        return policies.afterFocus(rpc);
      case 'repeatTapGap':
        return policies.repeatTapGap();
      case 'afterTextInput':
        return policies.afterTextInput(rpc);
      case 'afterPressKey':
        return policies.afterPressKey(rpc);
      case 'afterNav':
        return policies.afterNav(rpc);
      case 'afterHideKeyboard':
        return policies.afterHideKeyboard();
      case 'preSwipe':
        return policies.preSwipe(rpc);
      case 'afterSwipe':
        return policies.afterSwipe(rpc);
      case 'afterLaunch':
        return policies.afterLaunch(rpc);
    }
  }
}
