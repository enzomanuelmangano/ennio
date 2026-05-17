# Native UIKit / SwiftUI Component Coverage

> Demo video: [`docs/native-components-demo.mp4`](./docs/native-components-demo.mp4) — full sweep of every flow in this document running back-to-back on iOS 26 simulator.

How Ennio drives every native iOS component a React Native app commonly uses, including the iOS 26 SwiftUI-hosted ones where the legacy UIKit class is gone from the view tree.

For each component this document records:
- **Component** — the public API the app uses (RN side)
- **Detection** — how Ennio locates the underlying iOS UI
- **Socket op** — the native handler invoked over the Unix-domain control socket
- **Fast-path** — where the runner short-circuits to it before falling to HID
- **Cost** — wall-clock budget per interaction in this repo's gauntlet flows
- **Notes** — iOS 26 quirks, edge cases, fallbacks

The whole control-socket bypass exists so handlers that don't touch React state aren't queued behind a busy JS thread — see `cpp/EnnioControlSocket.cpp` and the README.

---

## 1. UITabBarController items (bottom tabs)

| | |
|---|---|
| Component | `expo-router` bottom tabs / React Navigation `Tab.Navigator` (renders to `UITabBarController`) |
| Detection | Walk `[UIApplication sharedApplication].connectedScenes` → `UIWindowScene.windows` → recurse into `rootViewController` for any `UITabBarController`; match by `vc.tabBarItem.title` or `vc.title` (case-insensitive) |
| Socket op | `tapTabByName` (`EnnioRuntimeHelper::tapTabByName`) |
| Fast-path | `maestro-runner.ts` `tap()` — runs before alert/picker/HID; guards with `isAlertPresent()` so a tab tap doesn't fire while a modal alert is on top |
| Cost | ~3 ms socket round-trip + ~100 ms post-tap settle |
| Notes | Calls `tabBarController:shouldSelectViewController:` → `selectedIndex = idx` → `tabBarController:didSelectViewController:` so RNScreens NativeTabs emits `onNativeFocusChange`. Pops any nav stack on top of the tab controller before switching so the destination tab is actually visible. Originally root cause of the 2 s+ tab-tap on iOS 26 liquid-glass tab bar (CDP `Runtime.evaluate` queued behind JS work); socket bypass made it instant. |

Flow: `example/maestro-e2e/01-auth-flow.yaml` (and every flow that does `tapOn: 'Gauntlet'`).

---

## 2. UIAlertController (Alert.alert)

| | |
|---|---|
| Component | `Alert.alert(...)` from `react-native` |
| Detection | Walk `connectedScenes` → for each window in reverse order (alert window is on top), walk `presentedViewController` chain looking for a `UIAlertController` instance |
| Socket op | `isAlertPresent` (probe), `tapAlertButton` (invoke action by title), `dismissAlert` (auto-pick Cancel/OK) |
| Fast-path | `tap()` — after the tab fast-path, before HID. If a UIAlertController is presented and the selector text matches a `UIAlertAction.title`, invoke the action's handler block directly via `UIAlertAction.handler` private getter |
| Cost | <5 ms |
| Notes | The alert lives on its own `UIWindowLevelAlert` window — a key-window-only lookup misses it; reverse-iterating windows finds it first try. Action invocation bypasses iOS's normal animation: button handler fires immediately + `[alert dismissViewControllerAnimated:NO]`. |

Flow: `example/maestro-e2e/g-alert.yaml`.

---

## 3. Navigation header items (`headerLeft` / `headerRight`)

| | |
|---|---|
| Component | RNScreens `<Stack.Screen options={{ headerLeft, headerRight }} />` (renders custom React views into `UINavigationItem.{left,right}BarButtonItems` via `UIBarButtonItem.customView`) |
| Detection | Existing `getViewWindowFrame` walks `UINavigationBar.subviews` recursively, matches `accessibilityIdentifier == testID`. RNScreens header custom views are in the view tree (managed by Fabric) so testID propagates normally. `isViewInActiveVCChain` accepts them because their `nextResponder` chain reaches the screen VC |
| Socket op | None new — uses existing `getViewWindowFrame` + HID tap |
| Fast-path | Standard `tapOn: { id: 'header-edit-btn' }` flow |
| Cost | ~300 ms per tap (auto-scroll layoutCenter poll ~5–90 ms + HID tap ~150 ms + assertVisible ~150 ms) |
| Notes | iOS native back chevron is handled by the `- back` Maestro command (separate path: walks for top UINavigationController and calls `popViewControllerAnimated:`). |

Flow: `example/maestro-e2e/g-nav-header.yaml`.

---

## 4. UIRefreshControl (pull-to-refresh)

| | |
|---|---|
| Component | `<ScrollView refreshControl={<RefreshControl onRefresh={...} />}>` |
| Detection | None needed — the trigger is a HID gesture |
| Socket op | None |
| Fast-path | Two consecutive HID swipes via `swipe: { start: '50%,25%', end: '50%,90%', duration: 500 }` |
| Cost | ~1.5 s for two swipes + onRefresh debounce |
| Notes | Single HID swipe is flaky on iOS 26 simulator — touch begin/end timing doesn't always cross the pan recogniser's refresh-trigger threshold and the spinner snaps back. Two swipes in a row reliably trip it: the first warms the recogniser, the second pulls past trigger. A deterministic single-call alternative (`[UIRefreshControl beginRefreshing]` + `sendActionsForControlEvents:UIControlEventValueChanged`) is not yet wired — the two-swipe approach is good enough for now. |

Flow: `example/maestro-e2e/g-refresh-control.yaml`.

---

## 5. UIPickerView (`@react-native-picker/picker`)

| | |
|---|---|
| Component | `<Picker selectedValue onValueChange><Picker.Item label value /></Picker>` from `@react-native-picker/picker` (renders a `UIPickerView` subclass `RNCPicker`) |
| Detection | Walk every connected window's view tree for `UIPickerView` instances. **Note**: the walk has to recurse into UIPickerView subviews and *not* gate on `view.window != nil` (that check rejects UIWindow roots themselves — earlier bug, now fixed in `collectPickerViewsIn`) |
| Socket op | `selectPickerValueByLabel` (`EnnioRuntimeHelper::selectPickerValueByLabel`) |
| Fast-path | `tap()` text-only branch — runs **before** the alert poll so picker selections don't pay the 2 s alert wait |
| Cost | ~3 ms socket round-trip |
| Notes | Iterates every component (not just component 0) so multi-wheel pickers (UIDatePicker) work too. For each row, queries `pickerView:titleForRow:forComponent:` → `attributedTitle:` → `viewForRow:` (custom row view UILabel.text). Calls `selectRow:inComponent:animated:` then fires `pickerView:didSelectRow:inComponent:` on the delegate so `RNCPicker` emits `onValueChange` (programmatic `selectRow` alone does not fire the delegate). |

Flow: `example/maestro-e2e/g-picker.yaml`.

---

## 6. UISearchBar (iOS 26 SwiftUI host)

| | |
|---|---|
| Component | RNScreens `<Stack.Screen options={{ headerSearchBarOptions: { placeholder, onChangeText } }} />` |
| Detection | iOS 26 replaced UIKit `UISearchBar` with SwiftUI `InlineSearchBarViewRepresentation` hosted in a `_TtGC5UIKit22UICorePlatformViewHost...` view. The legacy `UISearchBar` class returns 0 hits in a class walk even when the bar is visible. **Workaround**: walk for the inner private text field class `UISearchBarTextField` (a `UITextField` subclass), which survives the SwiftUI migration. Legacy `UISearchBar` walk kept as fallback for older iOS |
| Socket ops | `focusSearchBar(placeholder)`, `setSearchBarText(text)`, `appendSearchBarText(text)`, `eraseSearchBarText(count)` |
| Fast-path | `tap()` text-only branch — `tapOn-by-placeholder` routes via `focusSearchBar`; `inputText` routes via `appendSearchBarText`; `eraseText` routes via `eraseSearchBarText` |
| Cost | ~3 ms per op |
| Notes | All ops drive the underlying `UITextField` directly (assign `.text`, then fire `UIControlEventEditingChanged` + post `UITextFieldTextDidChangeNotification`). Both the SwiftUI host AND the legacy `UISearchBarDelegate` bridge observe these events, so RNScreens' `onChangeText` fires for both worlds. `placeholder` argument to `focusSearchBar` is informational only — the SwiftUI host's `UISearchBarTextField.placeholder` is `""` (the visible placeholder lives in a sibling `UISearchBarTextFieldLabel`), so falls back to the first visible search field. `becomeFirstResponder` may be refused by the SwiftUI host on iOS 26 but doesn't matter: subsequent `appendSearchBarText` / `eraseSearchBarText` fall back to `firstSearchBarTextField`. |

Flow: `example/maestro-e2e/g-search-bar.yaml`. Drops from 25 s (HID retry-loop) to ~8 s.

---

## 7. UISegmentedControl (`@react-native-segmented-control/segmented-control`)

| | |
|---|---|
| Component | `<SegmentedControl values selectedIndex onChange />` (renders `RNCSegmentedControl` containing a `UISegmentedControl`) |
| Detection | Walk every connected window for `UISegmentedControl` instances; iterate `numberOfSegments` and match by `titleForSegmentAtIndex:` (case-insensitive) |
| Socket op | `selectSegmentByLabel` (`EnnioRuntimeHelper::selectSegmentByLabel`) |
| Fast-path | `tap()` text-only branch — between segmented-control and picker fast-paths |
| Cost | ~3 ms socket round-trip |
| Notes | Sets `selectedSegmentIndex` and dispatches `UIControlEventValueChanged` — `RNCSegmentedControl` listens to that and emits `onChange`. Without this fast-path, `tapOn: 'Week'` enters the slow back-stack-pop retry loop (~14 s per tap on iOS 26 simulator) because the segment titles aren't reliably matched via the shadow-tree text walk. With it, the whole 4-tap flow runs in ~7 s. |

Flow: `example/maestro-e2e/g-segmented.yaml`.

---

## 8. UIDatePicker spinner (`@react-native-community/datetimepicker`)

| | |
|---|---|
| Component | `<DateTimePicker value mode="date" display="spinner" onChange />` (renders `UIDatePicker` in spinner mode — internally a 3-component `UIPickerView`: month / day / year) |
| Detection | The `UIDatePicker`'s inner `UIPickerView` is reachable via the same walk used for plain pickers — `collectPickerViewsIn` recurses past `UIDatePicker` (which is a `UIControl`, not a `UIPickerView`) and finds the inner picker as a subview |
| Socket op | Same `selectPickerValueByLabel` — handles the multi-component case |
| Fast-path | Same `tap()` text-only branch as picker |
| Cost | ~500 ms per row selection (includes `TAP_NAV_SETTLE_MS`) |
| Notes | `selectPickerValueByLabel` iterates every component, so `tapOn: 'February'` finds the row in component 0 of the date picker even though component 1 is days and component 2 is years. `UIDatePicker` is the delegate of its own inner picker, so firing `pickerView:didSelectRow:inComponent:` updates `picker.date` and triggers the change. Day-of-month / year selection works the same way (just be careful with ambiguous row labels — e.g. "15" is a day in the date picker AND could collide with anything else with that text on screen; in practice picker rows are matched first because the picker fast-path runs before HID). |

Flow: `example/maestro-e2e/g-datepicker.yaml`.

---

## Inventory of remaining components

Native pieces NOT yet covered with dedicated fast-paths in this branch:
- **`UIMenu` / `UIContextMenuInteraction` / zeego dropdown** — out-of-process UI, requires private accessibility-audit APIs (`AXAuditApplication` / `XCAccessibilityElement`); deferred to the separate `perf/menu-private-ax` branch
- **`UIActionSheet`** — RN `Alert.alert` with three buttons currently renders as `UIAlertController` (handled). Native `UIActionSheet` (deprecated) untested
- **`UIStepper` / `UISwitch` (native, non-RN-wrapped)** — partial coverage via shadow tree when RN-wrapped; bare UIKit instances would need their own handler
- **`PKPaymentAuthorizationViewController` (Apple Pay)** — system sheet, can't be driven from the app process

Each of these can be added with the same pattern: walk for the class, expose a socket op, register in `EnnioControlSocket.cpp` + `SOCKET_FAST_OPS` + a `tap()` fast-path.

---

## How a new native component handler is added

1. Add the method on `EnnioRuntimeHelper` (header + .mm), preceded by a doc comment that explains *why* the native walk is needed (HID flaky, shadow-tree missing the element, etc.).
2. Wire the type in `cpp/EnnioControlSocket.cpp` `dispatchRequest`.
3. Add it to `SOCKET_FAST_OPS` in `src/cli/client.ts` so calls route over the socket instead of CDP.
4. Insert a fast-path block in `src/cli/maestro-runner.ts` `tap()` (or `typeText` / `eraseText`) — earlier in the order than the alert poll if the op is cheap and selective; later if it could collide with other matches.
5. Add a gauntlet screen under `example/app/gauntlet/<component>.tsx` + a flow under `example/maestro-e2e/g-<component>.yaml`.
6. Run the flow; iterate on the walk if it returns 0 hits (the iOS 26 SwiftUI-host case is the recurring trap — class walks miss components migrated to SwiftUI; walking for the underlying private UIKit text field / text label / etc. is the workaround).
