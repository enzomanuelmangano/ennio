# ennio-expo-plugin

> [!WARNING]
> **Experimental.** Companion to [`ennio`](https://www.npmjs.com/package/ennio).
> APIs and behavior may change without notice.

Expo config plugin that links the Ennio native runtime into your iOS
app's **Debug** builds only, via CocoaPods `:configurations`.

The plugin:

- Edits the generated `Podfile` to add `pod 'EnnioCore'` scoped to the
  Debug configuration. Release builds get a no-op — no Ennio symbols,
  no test-runner code ships in production.
- Writes an `ENNIORibbonEnabled` flag into `Info.plist` so the in-app
  ribbon indicator (Debug-only) can be toggled per profile.

## Install

```bash
npm install ennio ennio-expo-plugin react-native-nitro-modules
```

Then register in `app.json`:

```json
{
  "plugins": ["expo-router", "ennio-expo-plugin"]
}
```

Optional config:

```json
{
  "plugins": [
    [
      "ennio-expo-plugin",
      {
        "configurations": ["Debug"],
        "showRibbon": false
      }
    ]
  ]
}
```

Rebuild after configuring: `npx expo prebuild --clean && npx expo run:ios`.

## Docs

See [ennio's README](https://github.com/enzomanuelmangano/ennio#readme)
for architecture notes, the security model, and example flows.

## License

MIT
