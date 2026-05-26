//
// EnnioFindHandlers.h
//
// Registers the socket ops that locate views by testID or text:
//
//   find_by_testid          wait_find_by_testid
//   find_by_text            wait_find_by_text
//   find_by_testid_nth      find_child_by_testid
//   find_ax_by_text         visible
//   is_exposed              frame
//   count_by_testid         top_vc_chain
//

#pragma once

void RegisterEnnioFindHandlers(void);
