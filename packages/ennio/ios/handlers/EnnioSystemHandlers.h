//
// EnnioSystemHandlers.h
//
// Registers the socket ops that don't belong to find/wait/interaction:
//
//   Diagnostic: ping, finder_status, finder_probe, window_size, dump_views
//   Alerts:     alert_present, alert_text, alert_buttons, alert_tap, alert_dismiss
//   Scroll/nav: scroll, scroll_to, back, hide_keyboard
//   Refresh:    is_refreshing, trigger_refresh
//   Clipboard:  clipboard_copy, clipboard_paste, clipboard_text
//   App:        clear_state
//

#pragma once

void RegisterEnnioSystemHandlers(void);
