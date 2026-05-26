//
// EnnioWaitHandlers.h
//
// Registers the socket ops that gate on frame-hash / React-commit /
// presentation-transition stability:
//
//   wait_idle              wait_hash_change       frame_hash
//   react_commit_ts        wait_react_commit      wait_commit
//   wait_react_quiet       wait_presentation_idle
//

#pragma once

void RegisterEnnioWaitHandlers(void);
