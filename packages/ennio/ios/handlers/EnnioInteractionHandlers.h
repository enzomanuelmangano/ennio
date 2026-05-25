//
// EnnioInteractionHandlers.h
//
// Registers the socket ops that drive UI actions:
//
//   tap_tab            find_tab
//   activate_at_point  activate_testid    activate_by_text
//   focus_testid       first_responder_ready
//   insert_text        hardware_key
//   swipe_points
//

#pragma once

void RegisterEnnioInteractionHandlers(void);
