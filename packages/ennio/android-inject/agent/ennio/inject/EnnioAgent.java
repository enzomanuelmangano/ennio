package ennio.inject;

// EnnioAgent — in-app automation agent, INJECTED at runtime (not compiled
// into the target app). The native libennio.so (LD_PRELOAD via wrap.sh)
// attaches to the app's JVM, loads this class from an embedded dex via
// InMemoryDexClassLoader, and calls start(Application). Android parity
// with the iOS libennio dylib: the app is never recompiled.
//
// Everything runs in-process on the app's own threads — the fastest path
// for Android UI (per-call JNI from C++ would be slower). Gestures are
// MotionEvents dispatched on the decor view; settle is a frame hash kept
// fresh by an OnPreDrawListener. Transport is a LocalServerSocket in the
// abstract namespace "ennio", bridged to the host by adb forward.
//
// Framework-only dependencies (android.*, org.json) so the dex is
// self-contained and loads into any app.

import android.app.Activity;
import android.app.Application;
import android.graphics.Rect;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import android.widget.EditText;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.FutureTask;

public final class EnnioAgent {
    private static final String TAG = "Ennio";
    // Per-process abstract socket name. The abstract namespace is GLOBAL per
    // device, so a lingering agent from a prior flow that still holds a fixed
    // "ennio" name shadows the freshly-injected one: adb forward routes the CLI
    // to the stale agent, whose ready flag never flips for the new activity
    // ("@ennio never became ready"). Scoping the name to the pid makes every
    // agent bind a unique socket — no collision possible — and the CLI forwards
    // to the matching pid (it already knows it from waitForAppPid).
    private static final String SOCKET_NAME = "ennio_" + android.os.Process.myPid();
    private static final long FNV_OFFSET = -3750763034362895579L; // 1469598103934665603 (unsigned)
    private static final long FNV_PRIME = 1099511628211L;

    private static volatile boolean started = false;
    private static volatile boolean ready = false;
    private static volatile boolean resumed = false;
    private static Application appRef;
    private static final Handler mainHandler = new Handler(Looper.getMainLooper());

    private static WeakReference<Activity> activityRef = new WeakReference<>(null);

    private static volatile long currentHash = FNV_OFFSET;
    private static volatile long lastHashChangeMs = 0;
    private static ViewTreeObserver.OnPreDrawListener preDrawListener;
    private static WeakReference<View> observedRoot = new WeakReference<>(null);

    private EnnioAgent() {}

    private static volatile boolean socketStarted = false;

    /** Entry point invoked by the native injector. Idempotent. */
    public static synchronized void start(Application app) {
        if (started) return;
        started = true;
        appRef = app;
        lastHashChangeMs = SystemClock.uptimeMillis();
        app.registerActivityLifecycleCallbacks(lifecycle);
        // The injector attaches a few seconds after launch — the MainActivity
        // may have ALREADY resumed, in which case registerActivityLifecycle
        // Callbacks never delivers a retroactive onActivityResumed. Capture
        // the current resumed activity directly so find/tap have a decor view
        // and `ready` is true immediately.
        Activity cur = currentResumedActivity();
        if (cur != null) {
            activityRef = new WeakReference<>(cur);
            ready = true;
            resumed = true;
            mainHandler.post(EnnioAgent::installPreDrawObserver);
        }
        ensureSocketStarted();
        Log.i(TAG, "EnnioAgent injected");
    }

    private static synchronized void ensureSocketStarted() {
        if (socketStarted) return;
        socketStarted = true;
        Thread t = new Thread(EnnioAgent::acceptLoop, "ennio-accept");
        t.setDaemon(true);
        t.start();
        Log.i(TAG, "EnnioAgent listening on @" + SOCKET_NAME);
    }

    // The current RESUMED activity, read from ActivityThread — needed when we
    // inject after the activity already resumed (the lifecycle callback won't
    // fire retroactively).
    @SuppressWarnings("unchecked")
    private static Activity currentResumedActivity() {
        try {
            Class<?> atClass = Class.forName("android.app.ActivityThread");
            Object at = atClass.getMethod("currentActivityThread").invoke(null);
            Field mActivities = atClass.getDeclaredField("mActivities");
            mActivities.setAccessible(true);
            java.util.Map<Object, Object> acts = (java.util.Map<Object, Object>) mActivities.get(at);
            if (acts == null) return null;
            for (Object record : acts.values()) {
                Class<?> rc = record.getClass();
                Field pausedF = rc.getDeclaredField("paused");
                pausedF.setAccessible(true);
                if (!pausedF.getBoolean(record)) {
                    Field actF = rc.getDeclaredField("activity");
                    actF.setAccessible(true);
                    Object a = actF.get(record);
                    if (a instanceof Activity) return (Activity) a;
                }
            }
        } catch (Throwable ignored) {
        }
        return null;
    }

    private static final Application.ActivityLifecycleCallbacks lifecycle =
            new Application.ActivityLifecycleCallbacks() {
                public void onActivityCreated(Activity a, Bundle b) {}
                public void onActivityStarted(Activity a) {}
                public void onActivityResumed(Activity a) {
                    activityRef = new WeakReference<>(a);
                    ready = true;
                    resumed = true;
                    // Real UI process confirmed — safe to bind the socket now.
                    ensureSocketStarted();
                    mainHandler.post(EnnioAgent::installPreDrawObserver);
                }
                public void onActivityPaused(Activity a) { resumed = false; }
                public void onActivityStopped(Activity a) {}
                public void onActivitySaveInstanceState(Activity a, Bundle b) {}
                public void onActivityDestroyed(Activity a) {}
            };

    private static Activity topActivity() { return activityRef.get(); }

    // Readiness ping with LAZY recovery. The agent can be injected AFTER the
    // first activity already resumed, in which case onActivityResumed never
    // fires retroactively — `ready` would then stay false forever and the CLI
    // declares "@ennio never became ready" (the dominant CI retry flake, ~56s).
    // Re-resolve the resumed activity on every ping so readiness still flips
    // the instant the app reaches the foreground. Also reports diagnostics so
    // a stuck flag (resumedActivity=true) is distinguishable from a genuinely
    // un-resumed app (resumedActivity=false).
    private static JSONObject ping() {
        if (!ready) {
            Activity cur = currentResumedActivity();
            if (cur != null) {
                activityRef = new WeakReference<>(cur);
                ready = true;
                resumed = true;
                ensureSocketStarted();
                mainHandler.post(EnnioAgent::installPreDrawObserver);
            }
        }
        JSONObject r = new JSONObject();
        try {
            r.put("pong", true);
            r.put("bootstrap", ready ? "ready" : "pending");
            r.put("resumedActivity", currentResumedActivity() != null);
            r.put("hasActivityRef", topActivity() != null);
        } catch (Throwable ignored) {
        }
        return r;
    }

    private static View decorView() {
        Activity a = topActivity();
        return a == null ? null : a.getWindow().getDecorView();
    }

    // ── multi-window enumeration ─────────────────────────────────────
    // Dialogs, popup menus, pickers, toasts and bottom sheets each live in
    // a SEPARATE window — not under the Activity's decor view. Espresso /
    // UIAutomator read them through WindowManagerGlobal.mViews (every
    // attached root view, one per window). Reflect into it so find / hash
    // / gestures see the whole screen, not just the activity.
    private static Object wmgInstance;
    private static Field wmgViewsField;

    @SuppressWarnings("unchecked")
    private static List<View> rootViews() {
        try {
            if (wmgInstance == null) {
                Class<?> wmg = Class.forName("android.view.WindowManagerGlobal");
                Method getInstance = wmg.getMethod("getInstance");
                wmgInstance = getInstance.invoke(null);
                wmgViewsField = wmg.getDeclaredField("mViews");
                wmgViewsField.setAccessible(true);
            }
            Object v = wmgViewsField.get(wmgInstance);
            if (v instanceof List) return (List<View>) v;
            if (v instanceof View[]) {
                ArrayList<View> out = new ArrayList<>();
                for (View x : (View[]) v) out.add(x);
                return out;
            }
        } catch (Throwable e) {
            // Reflection blocked / shape changed — fall back to the
            // activity decor so single-window flows still work.
        }
        ArrayList<View> out = new ArrayList<>();
        View d = decorView();
        if (d != null) out.add(d);
        return out;
    }

    /** The window that should receive touches: the topmost VISIBLE root
     *  (last attached). A modal dialog/menu sits above the activity. */
    private static View gestureRoot() {
        List<View> roots = rootViews();
        for (int i = roots.size() - 1; i >= 0; i--) {
            View r = roots.get(i);
            if (r != null && r.getVisibility() == View.VISIBLE && r.getWindowToken() != null)
                return r;
        }
        return decorView();
    }

    /** Walk every window's tree, topmost window first (so find-first
     *  semantics prefer a dialog over the activity behind it). */
    private static void walkAll(Visitor visit) {
        List<View> roots = rootViews();
        for (int i = roots.size() - 1; i >= 0; i--) walk(roots.get(i), visit);
    }

    // ── main-thread marshaling ───────────────────────────────────────
    private static <T> T runOnUi(Callable<T> block) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            try { return block.call(); } catch (Exception e) { throw new RuntimeException(e); }
        }
        FutureTask<T> task = new FutureTask<>(block);
        mainHandler.post(task);
        try { return task.get(); } catch (Exception e) { throw new RuntimeException(e); }
    }

    // ── socket accept loop ───────────────────────────────────────────
    private static void acceptLoop() {
        while (true) {
            LocalServerSocket server = null;
            try {
                server = new LocalServerSocket(SOCKET_NAME);
                Log.i(TAG, "socket bound @" + SOCKET_NAME);
                while (true) {
                    final LocalSocket client = server.accept();
                    Thread t = new Thread(() -> serveConnection(client), "ennio-conn");
                    t.setDaemon(true);
                    t.start();
                }
            } catch (Throwable e) {
                // Bind can fail with "Address already in use" when an
                // intermittent wrap.sh throwaway process grabbed @ennio then
                // died (zombie holding the abstract socket). Retry FAST so we
                // reclaim it the instant the kernel releases it.
                try { if (server != null) server.close(); } catch (Throwable ignored) {}
                try { Thread.sleep(50); } catch (InterruptedException ignored) {}
            }
        }
    }

    private static void serveConnection(LocalSocket client) {
        try {
            BufferedReader reader = new BufferedReader(new InputStreamReader(client.getInputStream()));
            OutputStream out = client.getOutputStream();
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isEmpty()) continue;
                String resp = handleRequestLine(line);
                out.write((resp + "\n").getBytes());
                out.flush();
            }
        } catch (Throwable e) {
            Log.e(TAG, "connection error: " + e.getMessage());
        } finally {
            try { client.close(); } catch (Throwable ignored) {}
        }
    }

    private static String handleRequestLine(String line) {
        String id = null;
        try {
            JSONObject req = new JSONObject(line);
            id = req.optString("id", null);
            String op = req.optString("op", "");
            JSONObject args = req.optJSONObject("args");
            if (args == null) args = new JSONObject();
            if (op.isEmpty()) return errorResp(id, "missing op");
            Object data = dispatch(op, args);
            return okResp(id, data);
        } catch (Throwable e) {
            String msg = e.getMessage();
            return errorResp(id, msg != null ? msg : e.getClass().getSimpleName());
        }
    }

    private static String okResp(String id, Object data) {
        try {
            JSONObject o = new JSONObject();
            o.put("id", id != null ? id : JSONObject.NULL);
            o.put("ok", true);
            o.put("data", data != null ? data : JSONObject.NULL);
            return o.toString();
        } catch (Exception e) { return "{\"ok\":false,\"err\":\"resp-encode\"}"; }
    }

    private static String errorResp(String id, String err) {
        try {
            JSONObject o = new JSONObject();
            o.put("id", id != null ? id : JSONObject.NULL);
            o.put("ok", false);
            o.put("err", err);
            return o.toString();
        } catch (Exception e) { return "{\"ok\":false,\"err\":\"resp-encode\"}"; }
    }

    // ── dispatch ─────────────────────────────────────────────────────
    private static Object dispatch(String op, JSONObject a) throws Exception {
        switch (op) {
            case "ping":
                return ping();
            case "window_size": return windowSize();
            case "find_by_testid": return findByTestId(a.getString("testID"), 0);
            case "find_by_testid_nth": return findByTestId(a.getString("testID"), a.optInt("index", 0));
            case "find_by_text": return findByText(a.getString("text"), a.optBoolean("relaxed", false), a.optBoolean("regex", false));
            case "find_ax_by_text": return findByText(a.getString("text"), true, a.optBoolean("regex", false));
            case "find_child_by_testid":
                return findChildByTestId(a.getString("childTestID"), a.getString("parentTestID"));
            case "find_tap_target_by_testid": return findTapTarget(a.getString("testID"));
            case "wait_find_by_testid": return waitFind(a.getString("testID"), null, a.optInt("maxMs", 4000));
            case "wait_find_by_text": return waitFind(null, a.getString("text"), a.optInt("maxMs", 4000), a.optBoolean("regex", false));
            case "get_text": return getText(a.optString("testID", ""), a.optString("text", ""));
            case "visible": return new JSONObject().put("visible", isVisible(a.getString("testID")));
            case "is_exposed": return isExposed(a.optString("testID", ""), a.optString("text", ""));
            case "first_responder_ready": return new JSONObject().put("ready", firstResponderReady(a.optString("testID", "")));
            case "frame_hash": return new JSONObject().put("hash", Long.toHexString(currentHash));
            case "animations_active": return new JSONObject().put("active", animationsActive());
            case "react_commit_ts": return new JSONObject().put("ts", 0).put("attach", "none");
            case "wait_commit": return waitCommit(a.optInt("maxMs", 1000), a.optInt("stableMs", 100));
            case "wait_network_idle": return waitNetworkIdle(a.optInt("maxMs", 4000), a.optInt("idleMs", 120), a.optInt("graceMs", 0));
            case "net_inflight": return new JSONObject().put("n", netInflight());
            case "wait_react_commit": return waitReactCommit(a.optInt("maxMs", 1000));
            case "wait_hash_change": return waitHashChange(a.optString("sinceHash", ""), a.optInt("maxMs", 1000));
            case "wait_presentation_idle": return waitCommit(a.optInt("maxMs", 1000), 80);
            case "wait_scroll_idle": return waitScrollIdle(a.optInt("maxMs", 1200));
            case "tap": return tap(a.getDouble("x"), a.getDouble("y"), a.optDouble("holdMs", 60));
            case "double_tap": return doubleTap(a.getDouble("x"), a.getDouble("y"));
            case "swipe":
                return swipe(a.getDouble("x1"), a.getDouble("y1"), a.getDouble("x2"), a.getDouble("y2"),
                        a.optInt("durMs", 250));
            case "long_press_drag":
                return swipe(a.getDouble("x1"), a.getDouble("y1"), a.getDouble("x2"), a.getDouble("y2"),
                        a.optInt("holdMs", 400) + a.optInt("moveMs", 300));
            case "tap_tab": return tapTab(a.getString("name"));
            case "native_select": return new JSONObject().put("selected", nativeSelect(a.getString("text")));
            case "scroll_to": return scrollTo(a.getString("elementTestID"));
            case "reveal_tap": return revealTap(a.getString("testID"));
            case "activate_testid": return activateTestId(a.getString("testID"));
            case "activate_by_text": return activateByText(a.getString("text"));
            case "focus_testid": return focusTestId(a.getString("testID"));
            case "insert_text": return insertText(a.getString("text"), a.optString("testID", ""));
            case "hardware_key": return hardwareKey(a.getInt("keyCode"));
            case "hide_keyboard": return hideKeyboard();
            case "back": return back();
            case "alert_present": return new JSONObject().put("present", alertPresent());
            case "alert_dismiss": return alertDismiss();
            case "alert_tap": return new JSONObject().put("tapped", alertTap(a.getString("buttonText")));
            case "clear_state": return new JSONObject().put("cleared", false);
            case "dump_views": return dumpViews();
            case "ax_tree_snapshot": return new JSONObject().put("tree", dumpTreeString());
            case "top_vc_chain": {
                Activity a2 = topActivity();
                return new JSONObject().put("chain",
                        new JSONArray().put(a2 != null ? a2.getClass().getName() : "none"));
            }
            case "finder_probe":
                return new JSONObject().put("index", false)
                        .put("uiview", findByTestIdOrNull(a.getString("testID"), 0) != null);
            default:
                throw new RuntimeException("unknown op: " + op);
        }
    }

    // ── geometry ─────────────────────────────────────────────────────
    private static JSONObject rectOf(View v) throws Exception {
        int[] loc = new int[2];
        v.getLocationOnScreen(loc);
        return new JSONObject().put("x", loc[0]).put("y", loc[1]).put("w", v.getWidth()).put("h", v.getHeight());
    }

    private static JSONObject windowSize() {
        return runOnUi(() -> {
            View d = decorView();
            if (d == null) d = gestureRoot();
            return new JSONObject().put("w", d == null ? 0 : d.getWidth())
                    .put("h", d == null ? 0 : d.getHeight());
        });
    }

    // ── testID / text resolution ─────────────────────────────────────
    private static volatile int reactTestIdResId = -1;

    private static int reactTestIdResId() {
        if (reactTestIdResId == -1) {
            try {
                Activity a = topActivity();
                reactTestIdResId = a == null ? 0
                        : a.getResources().getIdentifier("react_test_id", "id", a.getPackageName());
            } catch (Throwable e) { reactTestIdResId = 0; }
        }
        return reactTestIdResId;
    }

    private static String testIdOf(View v) {
        Object tag = v.getTag();
        if (tag instanceof String) return (String) tag;
        int rid = reactTestIdResId();
        if (rid != 0) {
            Object kt = v.getTag(rid);
            if (kt instanceof String) return (String) kt;
        }
        return null;
    }

    private static String textOf(View v) {
        if (v instanceof TextView) {
            TextView tv = (TextView) v;
            CharSequence t = tv.getText();
            if (t != null && t.length() > 0) return t.toString();
            // Empty input → match its placeholder (RN TextInput placeholder
            // maps to the EditText hint), so `tapOn: "Search fruit"` finds
            // an as-yet-unfilled field.
            CharSequence hint = tv.getHint();
            if (hint != null && hint.length() > 0) return hint.toString();
        }
        CharSequence cd = v.getContentDescription();
        return cd == null ? null : cd.toString();
    }

    private static boolean isShown(View v) {
        return v.getVisibility() == View.VISIBLE && v.getWidth() > 0 && v.getHeight() > 0
                && v.isShown() && v.getAlpha() > 0.01f;
    }

    private interface Visitor { void visit(View v); }

    private static void walk(View root, Visitor visit) {
        if (root == null) return;
        visit.visit(root);
        if (root instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) root;
            for (int i = 0; i < g.getChildCount(); i++) walk(g.getChildAt(i), visit);
        }
    }

    private static View findByTestIdOrNull(String testID, int index) {
        return runOnUi(() -> {
            ArrayList<View> matches = new ArrayList<>();
            walkAll(v -> { if (isShown(v) && testID.equals(testIdOf(v))) matches.add(v); });
            return index < matches.size() ? matches.get(index) : null;
        });
    }

    private static JSONObject findByTestId(String testID, int index) throws Exception {
        View v = findByTestIdOrNull(testID, index);
        if (v == null) throw new RuntimeException("element not found: testID=" + testID);
        return runOnUi(() -> rectOf(v));
    }

    private static View findByTextOrNull(String text, boolean relaxed) {
        return findByTextOrNull(text, relaxed, false);
    }

    private static View findByTextOrNull(String text, boolean relaxed, boolean regex) {
        // Maestro text selectors are regexes when they carry metacharacters
        // (e.g. "users[,]? or feeds"). Match partially (Pattern.find), the
        // same as a substring 'contains', so a placeholder that differs only
        // by an optional comma still resolves. Compile case-insensitively to
        // mirror the substring path; fall back to literal contains if the
        // pattern doesn't compile.
        final java.util.regex.Pattern pat;
        if (regex) {
            java.util.regex.Pattern p;
            try {
                p = java.util.regex.Pattern.compile(text, java.util.regex.Pattern.CASE_INSENSITIVE);
            } catch (Throwable e) {
                p = null;
            }
            pat = p;
        } else {
            pat = null;
        }
        return runOnUi(() -> {
            // Case-INSENSITIVE match: Android applies CSS textTransform
            // (uppercase) to the View's text — getText() returns "ORDERS"
            // where iOS keeps the original "Orders". Flows are authored to
            // the iOS casing, so compare case-insensitively.
            String needle = text.toLowerCase();
            View[] exact = new View[1];
            View[] contains = new View[1];
            walkAll(v -> {
                if (!isShown(v)) return;
                String t = textOf(v);
                if (t == null) return;
                if (pat != null) {
                    if (pat.matcher(t).find() && contains[0] == null) contains[0] = v;
                    return;
                }
                String lt = t.toLowerCase();
                if (lt.equals(needle) && exact[0] == null) exact[0] = v;
                if (lt.contains(needle) && contains[0] == null) contains[0] = v;
            });
            return exact[0] != null ? exact[0] : contains[0];
        });
    }

    private static JSONObject findByText(String text, boolean relaxed, boolean regex) throws Exception {
        View v = findByTextOrNull(text, relaxed, regex);
        if (v == null) throw new RuntimeException("element not found: text=" + text);
        return runOnUi(() -> rectOf(v));
    }

    private static JSONObject findChildByTestId(String childTestID, String parentTestID) {
        return runOnUi(() -> {
            View[] parent = new View[1];
            walkAll(v -> { if (parentTestID.equals(testIdOf(v))) parent[0] = v; });
            if (parent[0] == null) throw new RuntimeException("parent not found: " + parentTestID);
            View[] child = new View[1];
            walk(parent[0], v -> {
                if (v != parent[0] && isShown(v) && childTestID.equals(testIdOf(v)) && child[0] == null)
                    child[0] = v;
            });
            if (child[0] == null) throw new RuntimeException("child not found: " + childTestID);
            return rectOf(child[0]);
        });
    }

    private static JSONObject findTapTarget(String testID) {
        return runOnUi(() -> {
            View[] target = new View[1];
            walkAll(v -> { if (isShown(v) && testID.equals(testIdOf(v))) target[0] = v; });
            if (target[0] == null) throw new RuntimeException("element not found: testID=" + testID);
            View cursor = target[0];
            View clickable = null;
            while (cursor != null) {
                if (cursor.isClickable()) { clickable = cursor; break; }
                cursor = (cursor.getParent() instanceof View) ? (View) cursor.getParent() : null;
            }
            View use = clickable != null ? clickable : target[0];
            return rectOf(use).put("kind", use == target[0] ? "self" : "descendant");
        });
    }

    private static JSONObject waitFind(String testID, String text, int maxMs) throws Exception {
        return waitFind(testID, text, maxMs, false);
    }

    private static JSONObject waitFind(String testID, String text, int maxMs, boolean regex) throws Exception {
        long deadline = SystemClock.uptimeMillis() + maxMs;
        while (SystemClock.uptimeMillis() < deadline) {
            View v = testID != null ? findByTestIdOrNull(testID, 0) : findByTextOrNull(text, true, regex);
            if (v != null) return runOnUi(() -> rectOf(v));
            Thread.sleep(50);
        }
        throw new RuntimeException("element not found (wait): " + (testID != null ? testID : text));
    }

    private static JSONObject getText(String testID, String text) {
        return runOnUi(() -> {
            View v;
            if (!testID.isEmpty()) {
                View[] f = new View[1];
                walkAll(x -> { if (testID.equals(testIdOf(x))) f[0] = x; });
                v = f[0];
            } else {
                v = findByTextOrNull(text, true);
            }
            if (v == null) throw new RuntimeException("element not found for get_text");
            String t = textOf(v);
            return new JSONObject().put("text", t == null ? "" : t);
        });
    }

    private static boolean isVisible(String testID) { return findByTestIdOrNull(testID, 0) != null; }

    private static JSONObject isExposed(String testID, String text) {
        return runOnUi(() -> {
            View v;
            if (!testID.isEmpty()) v = findFirst(x -> testID.equals(testIdOf(x)));
            else v = findByTextOrNull(text, true);
            boolean found = v != null;
            // Exposed only when the target's centre falls inside its
            // window — an element scrolled below the fold is "found" (it's
            // in the tree) but not tappable. The CLI uses this to trigger
            // scroll_to before tapping.
            boolean exposed = found && onScreen(v);
            boolean enabled = v == null || v.isEnabled();
            return new JSONObject().put("found", found).put("exposed", exposed)
                    .put("childHijack", false).put("enabled", enabled);
        });
    }

    private static boolean onScreen(View v) {
        int[] loc = new int[2];
        v.getLocationOnScreen(loc);
        int cx = loc[0] + v.getWidth() / 2;
        int cy = loc[1] + v.getHeight() / 2;
        View root = decorView();
        int w = root != null ? root.getWidth() : 0;
        int h = root != null ? root.getHeight() : 0;
        if (cx < 0 || cy < 0 || (w != 0 && cx > w) || (h != 0 && cy > h)) return false;
        // Occluded by the bottom tab bar? Its centre is on-screen but a tap
        // there hits the tab bar, not the content. Treat as not-exposed so
        // the CLI scrolls it clear first.
        int tabTop = bottomBarTop();
        if (tabTop > 0 && cy >= tabTop) return false;
        return true;
    }

    /** Top Y of a visible Material bottom-tab bar, or -1 if none. */
    private static int bottomBarTop() {
        int[] top = { Integer.MAX_VALUE };
        walkAll(v -> {
            String cn = v.getClass().getName();
            if ((cn.contains("BottomNavigationView") || cn.contains("NavigationBarView"))
                    && isShown(v)) {
                int[] loc = new int[2];
                v.getLocationOnScreen(loc);
                if (loc[1] > 0 && loc[1] < top[0]) top[0] = loc[1];
            }
        });
        return top[0] == Integer.MAX_VALUE ? -1 : top[0];
    }

    // Select a value in a native widget that doesn't expose its choices as
    // tappable views until opened — a Spinner (@react-native-picker/picker
    // on Android) or a NumberPicker (spinner-mode date/number pickers). The
    // iOS-authored flows `tapOn` the value directly (iOS shows an inline
    // wheel); on Android we set the selection programmatically, which fires
    // the same onValueChange. Returns true when a widget held that value.
    private static boolean nativeSelect(String text) {
        return runOnUi(() -> {
            boolean[] done = { false };
            walkAll(v -> {
                if (done[0]) return;
                if (v instanceof android.widget.Spinner) {
                    android.widget.Spinner sp = (android.widget.Spinner) v;
                    android.widget.SpinnerAdapter ad = sp.getAdapter();
                    if (ad == null) return;
                    for (int i = 0; i < ad.getCount(); i++) {
                        Object item = ad.getItem(i);
                        if (item != null && item.toString().equalsIgnoreCase(text)) {
                            sp.setSelection(i, true);
                            done[0] = true;
                            return;
                        }
                    }
                } else if (v instanceof android.widget.NumberPicker) {
                    android.widget.NumberPicker np = (android.widget.NumberPicker) v;
                    String[] vals = np.getDisplayedValues();
                    if (vals != null) {
                        for (int i = 0; i < vals.length; i++) {
                            if (text.equalsIgnoreCase(vals[i])) {
                                np.setValue(np.getMinValue() + i);
                                done[0] = true;
                                return;
                            }
                        }
                    }
                } else if (v.getClass().getName().contains("SearchView")) {
                    // Native header search bar (react-native-screens
                    // headerSearchBarOptions). On Android it's a COLLAPSED
                    // SearchView whose placeholder/hint isn't a tappable view
                    // until expanded — `tapOn: "<placeholder>"` can't find it.
                    // Match by queryHint, then expand + focus so the next
                    // inputText types into it (iOS shows it expanded already).
                    try {
                        Object qh = v.getClass().getMethod("getQueryHint").invoke(v);
                        if (qh != null && qh.toString().equalsIgnoreCase(text)) {
                            v.getClass().getMethod("setIconified", boolean.class).invoke(v, false);
                            v.requestFocus();
                            done[0] = true;
                            return;
                        }
                    } catch (Throwable ignored) {
                    }
                }
            });
            return done[0];
        });
    }

    // Select a native bottom-tab by its label. expo-router NativeTabs use
    // a Material BottomNavigationView whose items don't always honour a raw
    // MotionEvent at their centre; performClick on the item view drives the
    // tab selection deterministically. Returns {tapped:false} when no tab
    // with that label exists (caller falls back to a normal tap).
    // Tab labels seen while the bottom bar was mounted. Used to decide,
    // on a tap_tab miss, whether `name` is a genuine tab worth popping
    // back to (vs. an ordinary text tap that simply isn't a tab).
    private static final java.util.Set<String> knownTabLabels =
            java.util.Collections.synchronizedSet(new java.util.HashSet<String>());

    private static JSONObject tapTab(String name) throws Exception {
        JSONObject r = runOnUi(() -> tabClickOnce(name));
        if (r.optBoolean("tapped", false)) return r;
        // The tab isn't in the current tree. react-native-screens native-stack
        // UNMOUNTS the tab container when a screen is pushed over it at the root
        // (e.g. /orders pushed above the tabs), so the bottom bar — and every
        // tab — vanishes from the hierarchy. iOS keeps lower screens mounted, so
        // the iOS-authored `tapOn: <tabName>` that returns from a pushed screen
        // via the tab bar has no tab to hit on Android. Recover by popping back
        // to the tabs, then selecting. Guard on a PREVIOUSLY-SEEN tab label so a
        // normal text tap that merely happens to miss never disturbs navigation.
        if (!knownTabLabels.contains(name)) return r;
        for (int i = 0; i < 6; i++) {
            boolean popped = runOnUi(() -> {
                View nav = findHeaderBackButton();
                if (nav == null) return false;
                if (!nav.performClick()) {
                    int[] loc = new int[2];
                    nav.getLocationOnScreen(loc);
                    long t = SystemClock.uptimeMillis();
                    dispatchTouch(MotionEvent.ACTION_DOWN, loc[0] + nav.getWidth() / 2f,
                            loc[1] + nav.getHeight() / 2f, t);
                    dispatchTouch(MotionEvent.ACTION_UP, loc[0] + nav.getWidth() / 2f,
                            loc[1] + nav.getHeight() / 2f, t);
                }
                return true;
            });
            if (!popped) break;
            waitCommit(800, 120);
            JSONObject r2 = runOnUi(() -> tabClickOnce(name));
            if (r2.optBoolean("tapped", false)) return r2;
        }
        return r;
    }

    // One pass: find the bottom-tab item labelled `name` and click it,
    // recording every tab label seen for the pop-back recovery above.
    private static JSONObject tabClickOnce(String name) throws org.json.JSONException {
        View[] item = new View[1];
        walkAll(v -> {
            String cn = v.getClass().getName();
            boolean tabbish = cn.contains("BottomNavigationItemView")
                    || cn.contains("NavigationBarItemView")
                    || cn.contains("TabView");
            if (!tabbish) return;
            String label = deepText(v);
            if (label != null) knownTabLabels.add(label);
            if (item[0] == null && containsText(v, name)) item[0] = v;
        });
        boolean tapped = false;
        if (item[0] != null) {
            tapped = item[0].performClick();
            if (!tapped) {
                // Some item views delegate the click to a parent; try it.
                View p = item[0].getParent() instanceof View ? (View) item[0].getParent() : null;
                if (p != null) tapped = p.performClick();
            }
        }
        return new JSONObject().put("tapped", tapped);
    }

    private static String deepText(View root) {
        String[] out = new String[1];
        walk(root, v -> { if (out[0] == null) { String t = textOf(v); if (t != null) out[0] = t; } });
        return out[0];
    }

    private static boolean containsText(View root, String needle) {
        boolean[] hit = { false };
        walk(root, v -> {
            if (hit[0]) return;
            String t = textOf(v);
            if (t != null && t.equals(needle)) hit[0] = true;
        });
        return hit[0];
    }

    // Scroll the target into the visible viewport by asking its ancestor
    // scroll containers to reveal it (requestRectangleOnScreen walks the
    // parent chain, scrolling each ScrollView/RecyclerView as needed).
    private static JSONObject scrollTo(String testID) {
        return runOnUi(() -> {
            View v = findFirst(x -> testID.equals(testIdOf(x)));
            if (v == null) throw new RuntimeException("scroll_to: not found " + testID);
            boolean scrolled = v.requestRectangleOnScreen(new Rect(0, 0, v.getWidth(), v.getHeight()), true);
            // requestRectangleOnScreen counts a row UNDER the (overlay) tab
            // bar as "visible", so a bottom-of-list item ends up beneath it
            // and its tap hits the tab bar instead. Lift the target to ~40%
            // of the screen by scrolling its nearest scrollable ancestor —
            // clear of any bottom bar.
            View root = decorView();
            int winH = root != null ? root.getHeight() : 0;
            if (winH > 0) {
                int[] loc = new int[2];
                v.getLocationOnScreen(loc);
                int centerY = loc[1] + v.getHeight() / 2;
                int desiredY = (int) (winH * 0.4);
                int delta = centerY - desiredY;
                if (Math.abs(delta) > 24) {
                    View sc = v.getParent() instanceof View ? (View) v.getParent() : null;
                    while (sc != null) {
                        String cn = sc.getClass().getName();
                        if (sc instanceof android.widget.ScrollView
                                || cn.contains("RecyclerView")
                                || cn.contains("ScrollView")) {
                            sc.scrollBy(0, delta);
                            scrolled = true;
                            break;
                        }
                        sc = sc.getParent() instanceof View ? (View) sc.getParent() : null;
                    }
                }
            }
            return new JSONObject().put("scrolled", scrolled);
        });
    }

    // Reveal a testID that an off-screen horizontal scroller has clipped out
    // of the native tree (Android FlatList/ScrollView default
    // removeClippedSubviews detaches off-viewport children — iOS keeps them
    // mounted, so an iOS-authored `tapOn` on a horizontal-list item that
    // scrolled out of view finds nothing here). Sweep each horizontal
    // scroller left→right; the moment the child re-attaches, tap it. Used as
    // the find-miss fallback for an id selector (AndroidPlatform.ax.tapTarget).
    private static JSONObject revealTap(String testID) throws Exception {
        if (tapTestIdIfPresent(testID)) return new JSONObject().put("tapped", true);
        java.util.List<View> scrollers = runOnUi(() -> {
            java.util.List<View> out = new java.util.ArrayList<>();
            walkAll(v -> {
                String cn = v.getClass().getName();
                boolean horiz = v instanceof android.widget.HorizontalScrollView
                        || cn.contains("HorizontalScrollView");
                if (!horiz && cn.contains("RecyclerView")) {
                    horiz = v.canScrollHorizontally(1) || v.canScrollHorizontally(-1);
                }
                if (horiz) out.add(v);
            });
            return out;
        });
        for (View sc : scrollers) {
            // Back to the left edge first — the most common clipped item is
            // the leftmost one (e.g. an "All" filter chip) after the list
            // scrolled right onto a later selection.
            runOnUi(() -> { sc.scrollTo(0, sc.getScrollY()); return null; });
            waitCommit(500, 100);
            if (tapTestIdIfPresent(testID)) return new JSONObject().put("tapped", true);
            int width = runOnUi(() -> sc.getWidth());
            int step = Math.max(120, (int) (width * 0.8));
            for (int i = 0; i < 12; i++) {
                final int target = (i + 1) * step;
                boolean moved = runOnUi(() -> {
                    int before = sc.getScrollX();
                    sc.scrollTo(target, sc.getScrollY());
                    return sc.getScrollX() != before;
                });
                waitCommit(400, 80);
                if (tapTestIdIfPresent(testID)) return new JSONObject().put("tapped", true);
                if (!moved) break;
            }
        }
        return new JSONObject().put("tapped", false);
    }

    private static boolean tapTestIdIfPresent(String testID) throws Exception {
        JSONObject rect = runOnUi(() -> {
            View v = findFirst(x -> testID.equals(testIdOf(x)));
            return v == null ? null : rectOf(v);
        });
        if (rect == null) return false;
        double cx = rect.getInt("x") + rect.getInt("w") / 2.0;
        double cy = rect.getInt("y") + rect.getInt("h") / 2.0;
        tap(cx, cy, 60);
        return true;
    }

    private interface Pred { boolean test(View v); }

    private static View findFirst(Pred pred) {
        View[] f = new View[1];
        walkAll(v -> { if (f[0] == null && isShown(v) && pred.test(v)) f[0] = v; });
        return f[0];
    }

    // Readiness is by IDENTITY when a testID is given: the focused EditText
    // must be THAT field. RN switches focus asynchronously, so during a
    // sheet-dismiss / focus hand-off the PREVIOUS field still answers
    // isFocused()=true — without the identity check, inputText lands in the
    // stale field (bsky login: "Alice" appended to the custom-server URL
    // because customServerTextInput kept focus while the sheet settled).
    private static boolean firstResponderReady(String testID) {
        return runOnUi(() -> {
            View f = findFirst(v -> v instanceof EditText && v.isFocused());
            if (f == null) return false;
            if (testID == null || testID.isEmpty()) return true;
            return testID.equals(testIdOf(f));
        });
    }

    // ── settle: network idle ─────────────────────────────────────────
    // Count RN's in-flight HTTP calls via the shared OkHttp dispatcher.
    // Reflection-only (the agent compiles against android.jar; RN/OkHttp
    // classes exist solely on-device). Returns -1 when the dispatcher
    // can't be reached (no RN networking, obfuscated build, or a non-RN
    // app) so the caller can treat the signal as unavailable rather than
    // "idle". This is what closes async-after-navigation races without a
    // blind sleep — e.g. bsky login: the form needs describeServer to land
    // before it can map "alice" → "alice.test", and nothing visible marks
    // that arrival, but the in-flight count drops to zero exactly when it
    // does.
    private static volatile Object okHttpDispatcher = null;
    private static volatile boolean okHttpResolved = false;

    private static Object okHttpDispatcher() {
        if (okHttpResolved) return okHttpDispatcher;
        try {
            Class<?> prov = Class.forName(
                    "com.facebook.react.modules.network.OkHttpClientProvider");
            Object client = prov.getMethod("getOkHttpClient").invoke(null);
            okHttpDispatcher = client.getClass().getMethod("dispatcher").invoke(client);
        } catch (Throwable e) {
            okHttpDispatcher = null;
        }
        okHttpResolved = true;
        return okHttpDispatcher;
    }

    /** In-flight + queued RN HTTP calls, or -1 if the count is unavailable. */
    private static int netInflight() {
        Object d = okHttpDispatcher();
        if (d == null) return -1;
        try {
            int running = (int) d.getClass().getMethod("runningCallsCount").invoke(d);
            int queued = (int) d.getClass().getMethod("queuedCallsCount").invoke(d);
            return running + queued;
        } catch (Throwable e) {
            return -1;
        }
    }

    // graceMs: how long to keep watching for a request to APPEAR before
    // concluding "never busy". An action's network call often fires a few
    // frames after the UI settles (bsky: setServiceUrl runs in the dialog's
    // close-animation callback, so describeServer starts well after the tap).
    // With grace>0 a caller can gate a submit on a not-yet-started lookup;
    // grace=0 keeps the cheap "already idle → return now" behaviour.
    private static JSONObject waitNetworkIdle(int maxMs, int idleMs, int graceMs) throws Exception {
        long start = SystemClock.uptimeMillis();
        long deadline = start + maxMs;
        long idleSince = -1;
        boolean sawBusy = false;
        while (SystemClock.uptimeMillis() < deadline) {
            int n = netInflight();
            if (n < 0) return new JSONObject().put("idle", false).put("known", false);
            long now = SystemClock.uptimeMillis();
            if (n > 0) {
                sawBusy = true;
                idleSince = -1;
            } else {
                // Nothing in flight. If we've already watched a request drain,
                // confirm idleMs of quiet and return. Otherwise keep watching
                // until the grace window elapses — a request may be imminent
                // (the close-animation callback hasn't fired its fetch yet).
                if (sawBusy) {
                    if (idleSince < 0) idleSince = now;
                    if (now - idleSince >= idleMs)
                        return new JSONObject().put("idle", true).put("known", true).put("waited", true);
                } else if (now - start >= graceMs) {
                    return new JSONObject().put("idle", true).put("known", true).put("waited", false);
                }
            }
            SystemClock.sleep(20);
        }
        return new JSONObject().put("idle", false).put("known", true).put("waited", sawBusy);
    }

    // ── settle: pre-draw frame hash ──────────────────────────────────
    private static void installPreDrawObserver() {
        // Observe the activity's decor (stable across dialog open/close);
        // the hash itself spans every window, so dialogs/menus still move
        // the settle signal whenever the activity redraws.
        final View root = decorView();
        if (root == null) return;
        if (observedRoot.get() == root && preDrawListener != null) return;
        if (preDrawListener != null) {
            View old = observedRoot.get();
            if (old != null) {
                ViewTreeObserver vto = old.getViewTreeObserver();
                if (vto.isAlive()) vto.removeOnPreDrawListener(preDrawListener);
            }
        }
        preDrawListener = () -> {
            long h = computeHashAll();
            if (h != currentHash) {
                currentHash = h;
                lastHashChangeMs = SystemClock.uptimeMillis();
            }
            return true;
        };
        root.getViewTreeObserver().addOnPreDrawListener(preDrawListener);
        observedRoot = new WeakReference<>(root);
    }

    private static long computeHashAll() {
        long[] h = { FNV_OFFSET };
        int[] loc = new int[2];
        List<View> roots = rootViews();
        for (int i = 0; i < roots.size(); i++) {
            View r = roots.get(i);
            if (r != null) recHash(r, h, loc);
        }
        return h[0];
    }

    private static void feed(long[] h, String s) {
        for (int i = 0; i < s.length(); i++) { h[0] ^= s.charAt(i); h[0] *= FNV_PRIME; }
    }
    private static void feedInt(long[] h, int v) { h[0] ^= v; h[0] *= FNV_PRIME; }

    private static void recHash(View v, long[] h, int[] loc) {
        if (v.getVisibility() != View.VISIBLE || v.getAlpha() < 0.01f) { feed(h, "HIDE"); return; }
        v.getLocationOnScreen(loc);
        feedInt(h, loc[0]); feedInt(h, loc[1]); feedInt(h, v.getWidth()); feedInt(h, v.getHeight());
        String tid = testIdOf(v);
        if (tid != null) feed(h, tid);
        if (v instanceof TextView) {
            CharSequence t = ((TextView) v).getText();
            if (t != null) feed(h, t.toString());
        }
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) recHash(g.getChildAt(i), h, loc);
        }
    }

    private static boolean animationsActive() {
        return SystemClock.uptimeMillis() - lastHashChangeMs < 100;
    }

    // Block until no scroll container is still moving. A tap delivered
    // while a list is flinging/settling is swallowed by the scroller as
    // "stop scrolling" and never reaches the row — so the CLI waits on this
    // before tapping a freshly-scrolled-to target. Idle = the summed
    // vertical+horizontal scroll offsets of every scrollable are unchanged
    // for 2 consecutive frames AND no RecyclerView reports a non-idle state.
    private static JSONObject waitScrollIdle(int maxMs) throws Exception {
        long start = SystemClock.uptimeMillis();
        long last = Long.MIN_VALUE;
        int streak = 0;
        while (SystemClock.uptimeMillis() - start < maxMs) {
            long sig = runOnUi(() -> {
                long[] acc = { 0 };
                boolean[] moving = { false };
                walkAll(v -> {
                    String cn = v.getClass().getName();
                    boolean scrollable = v instanceof android.widget.ScrollView
                            || v instanceof android.widget.HorizontalScrollView
                            || cn.contains("ScrollView") || cn.contains("RecyclerView");
                    if (!scrollable) return;
                    acc[0] = acc[0] * 31 + v.getScrollY();
                    acc[0] = acc[0] * 31 + v.getScrollX();
                    if (cn.contains("RecyclerView")) {
                        try {
                            Object st = v.getClass().getMethod("getScrollState").invoke(v);
                            if (st instanceof Integer && (Integer) st != 0) moving[0] = true;
                        } catch (Throwable ignored) {}
                    }
                });
                return moving[0] ? Long.MIN_VALUE + 1 : acc[0];
            });
            if (sig != Long.MIN_VALUE + 1 && sig == last) {
                if (++streak >= 2) {
                    return new JSONObject().put("ok", true)
                            .put("elapsedMs", (int) (SystemClock.uptimeMillis() - start));
                }
            } else {
                streak = 0;
            }
            last = sig;
            Thread.sleep(16);
        }
        return new JSONObject().put("ok", false).put("elapsedMs", maxMs);
    }

    private static JSONObject waitCommit(int maxMs, int stableMs) throws Exception {
        long start = SystemClock.uptimeMillis();
        while (true) {
            long now = SystemClock.uptimeMillis();
            int elapsed = (int) (now - start);
            if (elapsed >= maxMs) return new JSONObject().put("ok", false).put("elapsedMs", maxMs);
            if (now - lastHashChangeMs >= stableMs)
                return new JSONObject().put("ok", true).put("elapsedMs", elapsed);
            Thread.sleep(16);
        }
    }

    private static JSONObject waitReactCommit(int maxMs) throws Exception {
        long baseline = currentHash;
        long start = SystemClock.uptimeMillis();
        while (SystemClock.uptimeMillis() - start < maxMs) {
            if (currentHash != baseline)
                return new JSONObject().put("ok", true)
                        .put("elapsedMs", (int) (SystemClock.uptimeMillis() - start));
            Thread.sleep(16);
        }
        return new JSONObject().put("ok", false).put("elapsedMs", maxMs);
    }

    private static JSONObject waitHashChange(String sinceHash, int maxMs) throws Exception {
        long baseline;
        if (!sinceHash.isEmpty()) {
            try { baseline = Long.parseUnsignedLong(sinceHash, 16); } catch (Throwable e) { baseline = currentHash; }
        } else baseline = currentHash;
        long start = SystemClock.uptimeMillis();
        if (currentHash != baseline) return new JSONObject().put("ok", true).put("elapsedMs", 0);
        while (SystemClock.uptimeMillis() - start < maxMs) {
            if (currentHash != baseline)
                return new JSONObject().put("ok", true)
                        .put("elapsedMs", (int) (SystemClock.uptimeMillis() - start));
            Thread.sleep(16);
        }
        return new JSONObject().put("ok", false).put("elapsedMs", maxMs);
    }

    // ── gestures: in-process MotionEvent ─────────────────────────────
    private static boolean dispatchTouch(int action, float x, float y, long downTime) {
        return runOnUi(() -> {
            long now = SystemClock.uptimeMillis();
            View root = gestureRoot();
            if (root == null) return false;
            // Find coords are screen-space. dispatchTouchEvent wants the
            // target window's LOCAL space. The activity (and any full-screen
            // window) sits at (0,0) so they coincide — dispatch screen coords
            // directly. Only a genuinely OFFSET window (a centred dialog /
            // popup menu) needs correction; without it a tap on an alert
            // button would land on the dim backdrop. Guarding on a non-zero
            // origin keeps normal taps byte-identical to the screen-coord path.
            int[] loc = new int[2];
            root.getLocationOnScreen(loc);
            float lx = x - loc[0];
            float ly = y - loc[1];
            MotionEvent ev = MotionEvent.obtain(downTime, now, action, lx, ly, 0);
            // Mark the event as a real finger on the touchscreen. obtain()
            // leaves source=SOURCE_UNKNOWN, which react-native-gesture-handler's
            // orchestrator rejects — so RNGH-driven controls (pressto's
            // PressableScale, RectButton) inside a scroll view never recognized
            // the tap, while plain RN Pressables (which don't gate on source)
            // did. setSource makes the synthetic touch indistinguishable from a
            // dispatched hardware one.
            ev.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
            try {
                return root.dispatchTouchEvent(ev);
            } finally {
                ev.recycle();
            }
        });
    }

    private static JSONObject tap(double x, double y, double holdMs) throws Exception {
        long down = SystemClock.uptimeMillis();
        dispatchTouch(MotionEvent.ACTION_DOWN, (float) x, (float) y, down);
        Thread.sleep(Math.max(20, (long) holdMs));
        dispatchTouch(MotionEvent.ACTION_UP, (float) x, (float) y, down);
        return new JSONObject().put("ok", true);
    }

    private static JSONObject doubleTap(double x, double y) throws Exception {
        tap(x, y, 40);
        Thread.sleep(60);
        tap(x, y, 40);
        return new JSONObject().put("ok", true);
    }

    private static JSONObject swipe(double x1, double y1, double x2, double y2, int durMs) throws Exception {
        long down = SystemClock.uptimeMillis();
        int steps = Math.max(4, Math.min(60, durMs / 16));
        dispatchTouch(MotionEvent.ACTION_DOWN, (float) x1, (float) y1, down);
        for (int i = 1; i <= steps; i++) {
            float t = (float) i / steps;
            float x = (float) (x1 + (x2 - x1) * t);
            float y = (float) (y1 + (y2 - y1) * t);
            dispatchTouch(MotionEvent.ACTION_MOVE, x, y, down);
            Thread.sleep(Math.max(1, durMs / steps));
        }
        dispatchTouch(MotionEvent.ACTION_UP, (float) x2, (float) y2, down);
        return new JSONObject().put("ok", true);
    }

    // ── activation / focus / text ────────────────────────────────────
    // RN encodes pointerEvents on its ReactViewGroup (ReactPointerEventsView.
    // getPointerEvents() → PointerEvents enum). A real touch is hit-tested by
    // RN's TouchTargetHelper, which skips a subtree gated NONE (self+children)
    // or, for a descendant, BOX_ONLY (children). performClick bypasses that
    // hit-test, so it would fire a control a real finger can never reach (the
    // g-touchables "Blocked" button under a pointerEvents="none" wrapper).
    // Reflect the enum up the ancestor chain and refuse the activation when a
    // real tap would have been blocked. Non-RN views lack the method → null →
    // never blocked.
    private static String reactPointerEvents(View v) {
        try {
            Object pe = v.getClass().getMethod("getPointerEvents").invoke(v);
            return pe == null ? null : pe.toString();
        } catch (Throwable e) {
            return null;
        }
    }

    private static boolean pointerEventsBlocked(View target) {
        View v = target;
        boolean self = true;
        while (v != null) {
            String pe = reactPointerEvents(v);
            if (pe != null) {
                if ("NONE".equals(pe)) return true;
                if (!self && "BOX_ONLY".equals(pe)) return true;
            }
            android.view.ViewParent p = v.getParent();
            v = (p instanceof View) ? (View) p : null;
            self = false;
        }
        return false;
    }

    private static JSONObject activateTestId(String testID) {
        return runOnUi(() -> {
            View v = findFirst(x -> testID.equals(testIdOf(x)));
            if (v == null) throw new RuntimeException("not found: " + testID);
            if (pointerEventsBlocked(v))
                return new JSONObject().put("ok", false).put("blocked", true);
            View cursor = v;
            while (cursor != null && !cursor.isClickable())
                cursor = (cursor.getParent() instanceof View) ? (View) cursor.getParent() : null;
            boolean ok = cursor != null ? cursor.performClick() : v.performClick();
            return new JSONObject().put("ok", ok);
        });
    }

    private static JSONObject activateByText(String text) {
        return runOnUi(() -> {
            View v = findByTextOrNull(text, true);
            if (v == null) throw new RuntimeException("not found: " + text);
            if (pointerEventsBlocked(v))
                return new JSONObject().put("ok", false).put("blocked", true);
            View cursor = v;
            while (cursor != null && !cursor.isClickable())
                cursor = (cursor.getParent() instanceof View) ? (View) cursor.getParent() : null;
            return new JSONObject().put("ok", cursor != null && cursor.performClick());
        });
    }

    private static JSONObject focusTestId(String testID) {
        return runOnUi(() -> {
            View v = findFirst(x -> testID.equals(testIdOf(x)));
            if (v == null) throw new RuntimeException("not found: " + testID);
            return new JSONObject().put("ok", v.requestFocus());
        });
    }

    private static JSONObject insertText(String text, String testID) {
        return runOnUi(() -> {
            // Target by IDENTITY when a testID is given — never trust "the
            // focused EditText" alone, which can be a stale field mid focus
            // hand-off (bsky login custom-server race). Fall back to the
            // focused field, then any field.
            View f = null;
            if (testID != null && !testID.isEmpty())
                f = findFirst(v -> v instanceof EditText && testID.equals(testIdOf(v)));
            if (f == null) f = findFirst(v -> v instanceof EditText && v.isFocused());
            if (f == null) f = findFirst(v -> v instanceof EditText);
            if (!(f instanceof EditText)) throw new RuntimeException("no EditText focused");
            if (!f.isFocused()) f.requestFocus();
            EditText edit = (EditText) f;
            CharSequence cur = edit.getText();
            edit.setText((cur == null ? "" : cur.toString()) + text);
            edit.setSelection(edit.getText().length());
            return new JSONObject().put("ok", true);
        });
    }

    // The CLI sends USB-HID usage codes (the iOS dylib's convention).
    // Translate to Android KeyEvent keycodes.
    private static int hidToAndroidKey(int hid) {
        switch (hid) {
            case 40: return KeyEvent.KEYCODE_ENTER;     // return/enter
            case 42: return KeyEvent.KEYCODE_DEL;       // backspace
            case 43: return KeyEvent.KEYCODE_TAB;       // tab
            case 44: return KeyEvent.KEYCODE_SPACE;     // space
            case 41: return KeyEvent.KEYCODE_ESCAPE;    // escape
            default: return hid;                        // already an Android code
        }
    }

    private static JSONObject hardwareKey(int keyCode) {
        final int code = hidToAndroidKey(keyCode);
        return runOnUi(() -> {
            View v = findFirst(x -> x instanceof EditText && x.isFocused());
            if (v == null) v = decorView();
            if (v != null) {
                v.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, code));
                v.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, code));
            }
            return new JSONObject().put("ok", true);
        });
    }

    // A dialog/alert is present when there's a window above the activity's
    // (more than one root, or a non-activity topmost root).
    private static boolean alertPresent() {
        return runOnUi(() -> {
            List<View> roots = rootViews();
            View activityDecor = decorView();
            for (int i = roots.size() - 1; i >= 0; i--) {
                View r = roots.get(i);
                if (r != null && r != activityDecor && r.getVisibility() == View.VISIBLE
                        && r.getWindowToken() != null && r.getWidth() > 0) {
                    return true;
                }
            }
            return false;
        });
    }

    // Tap an alert/dialog BUTTON by text. A native AlertDialog renders its
    // title and its action button with the SAME label sometimes (e.g.
    // "Sign Out" title + "Sign Out" button); a plain text find hits the
    // non-clickable title and the action never fires. Match a CLICKABLE
    // view (Button) whose text equals the label and performClick it.
    private static boolean alertTap(String buttonText) {
        return runOnUi(() -> {
            String needle = buttonText.toLowerCase();
            View[] btn = new View[1];
            walkAll(v -> {
                if (btn[0] != null || !isShown(v) || !v.isClickable()) return;
                String t = textOf(v);
                if (t != null && t.toLowerCase().equals(needle)) btn[0] = v;
            });
            // Fallback: a clickable ancestor of a matching label.
            if (btn[0] == null) {
                View label = findFirst(v -> {
                    String t = textOf(v);
                    return t != null && t.toLowerCase().equals(needle);
                });
                View cur = label;
                while (cur != null && !cur.isClickable())
                    cur = cur.getParent() instanceof View ? (View) cur.getParent() : null;
                btn[0] = cur;
            }
            return btn[0] != null && btn[0].performClick();
        });
    }

    private static JSONObject alertDismiss() {
        return runOnUi(() -> {
            // Back dismisses the topmost dialog window without touching the
            // activity behind it.
            View root = gestureRoot();
            if (root != null) {
                root.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_BACK));
                root.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_BACK));
            }
            return new JSONObject().put("dismissed", true);
        });
    }

    private static JSONObject hideKeyboard() {
        return runOnUi(() -> {
            Activity a = topActivity();
            if (a != null) {
                android.view.inputmethod.InputMethodManager imm =
                        (android.view.inputmethod.InputMethodManager)
                                a.getSystemService(android.content.Context.INPUT_METHOD_SERVICE);
                View focus = a.getCurrentFocus();
                if (imm != null && focus != null)
                    imm.hideSoftInputFromWindow(focus.getWindowToken(), 0);
            }
            return new JSONObject().put("hidden", true);
        });
    }

    private static JSONObject back() {
        return runOnUi(() -> {
            Activity a = topActivity();
            if (a == null) return new JSONObject().put("popped", false);
            // On Android, system-back at the navigation root EXITS the app
            // (finishes the activity, which then cold-restarts blank). iOS
            // treats back-at-root as a no-op and the flows are authored to
            // that contract. react-native-screens native-stack keeps only
            // the TOP screen mounted, so depth can't be read from the tree —
            // but a pushed screen shows a header back button (the Toolbar
            // navigation icon), and a tab root does not. Click that button
            // to pop; if there's none, it's a root → no-op.
            View navBtn = findHeaderBackButton();
            if (navBtn != null) {
                boolean ok = navBtn.performClick();
                if (!ok) {
                    int[] loc = new int[2];
                    navBtn.getLocationOnScreen(loc);
                    long t = SystemClock.uptimeMillis();
                    dispatchTouch(MotionEvent.ACTION_DOWN, loc[0] + navBtn.getWidth() / 2f,
                            loc[1] + navBtn.getHeight() / 2f, t);
                    dispatchTouch(MotionEvent.ACTION_UP, loc[0] + navBtn.getWidth() / 2f,
                            loc[1] + navBtn.getHeight() / 2f, t);
                }
                return new JSONObject().put("popped", true);
            }
            // No standard back button (a screen with a CUSTOM headerLeft, e.g.
            // a "Cancel" button, replaces the chevron). Decide poppability from
            // the native-stack depth: react-native-screens' ScreenStack tracks
            // ALL its fragments via getScreenCount() even though only the top
            // Screen is mounted. Depth > 1 anywhere ⇒ a pushed screen exists.
            // We can't pop it in-process — under API 33+ predictive back RNS
            // registers on the window OnBackInvokedDispatcher, which nothing
            // in-process can trigger (Activity.onBackPressed(),
            // dispatcher.onBackPressed(), decorView.dispatchKeyEvent(BACK) all
            // no-op). Report "poppable but unpopped" so the CLI injects a real
            // `adb input keyevent BACK`. Gated on depth > 1, so a navigation
            // root never gets a hardware back that would exit the app.
            if (maxScreenStackDepth() > 1) {
                return new JSONObject().put("popped", false).put("poppable", true);
            }
            return new JSONObject().put("popped", false);
        });
    }

    // The react-native-screens header back affordance: an ImageButton (the
    // Toolbar navigation icon) sitting top-left inside a Toolbar/header.
    // Present on any pushed native-stack screen, absent at a tab root.
    private static View findHeaderBackButton() {
        View root = decorView();
        final int w = root != null && root.getWidth() > 0 ? root.getWidth() : 1080;
        View[] found = new View[1];
        walkAll(v -> {
            if (found[0] != null) return;
            if (!v.getClass().getSimpleName().contains("ImageButton")) return;
            if (!isShown(v) || !v.isClickable()) return;
            boolean inHeader = false;
            for (Object p = v.getParent(); p instanceof View; p = ((View) p).getParent()) {
                String cn = p.getClass().getSimpleName();
                if (cn.contains("Toolbar") || cn.contains("HeaderConfig")) { inHeader = true; break; }
            }
            if (!inHeader) return;
            int[] loc = new int[2];
            v.getLocationOnScreen(loc);
            // Top-left navigation slot.
            if (loc[0] < w / 3 && loc[1] < 500) found[0] = v;
        });
        return found[0];
    }

    // Deepest react-native-screens native-stack depth across all stacks.
    // ScreenStack (the container, NOT ScreenStackHeaderConfig) exposes
    // getScreenCount() = total fragments incl. non-top. >1 ⇒ poppable.
    private static int maxScreenStackDepth() {
        int[] max = { 0 };
        walkAll(v -> {
            if (!v.getClass().getName().endsWith(".ScreenStack")) return;
            try {
                Object n = v.getClass().getMethod("getScreenCount").invoke(v);
                if (n instanceof Integer) max[0] = Math.max(max[0], (Integer) n);
            } catch (Throwable ignored) {}
        });
        return max[0];
    }

    // ── diagnostics ──────────────────────────────────────────────────
    private static JSONArray dumpViews() {
        return runOnUi(() -> {
            JSONArray arr = new JSONArray();
            walkAll(v -> {
                if (!isShown(v)) return;
                String tid = testIdOf(v);
                String txt = textOf(v);
                if (tid != null || txt != null)
                    arr.put(v.getClass().getSimpleName() + " testID=" + tid + " text=" + txt);
            });
            return arr;
        });
    }

    private static String dumpTreeString() {
        return runOnUi(() -> {
            StringBuilder sb = new StringBuilder();
            recDump(decorView(), 0, sb, new int[2]);
            return sb.toString();
        });
    }

    private static void recDump(View v, int depth, StringBuilder sb, int[] loc) {
        if (v == null) return;
        v.getLocationOnScreen(loc);
        for (int i = 0; i < depth; i++) sb.append("  ");
        sb.append(v.getClass().getSimpleName())
          .append(" testID=").append(testIdOf(v))
          .append(" text=").append(v instanceof TextView ? ((TextView) v).getText() : null)
          .append(" [").append(loc[0]).append(",").append(loc[1])
          .append(" ").append(v.getWidth()).append("x").append(v.getHeight()).append("]\n");
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) recDump(g.getChildAt(i), depth + 1, sb, loc);
        }
    }
}
