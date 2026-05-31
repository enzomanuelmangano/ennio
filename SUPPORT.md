# Getting help

Ennio is an early-stage open source project maintained in spare time.
There is no paid support tier and no SLA. The fastest way to get a
useful answer is to make it easy for someone to reproduce what you
are seeing.

## Where to ask

| You want to…                                 | Use                                                                                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Report a reproducible bug                    | [GitHub Issues](https://github.com/enzomanuelmangano/ennio/issues) — pick the **Bug report** template                      |
| Request a Maestro command / CLI feature      | [GitHub Issues](https://github.com/enzomanuelmangano/ennio/issues) — pick the **Feature request** template                 |
| Ask a usage question or share a setup gotcha | [GitHub Discussions](https://github.com/enzomanuelmangano/ennio/discussions) (if enabled) or a new issue tagged `question` |
| Report a security vulnerability              | See [SECURITY.md](SECURITY.md) — email, do not open a public issue                                                         |
| Report a Code of Conduct violation           | See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)                                                                               |

## Before opening an issue

1. Search existing issues — your problem may already be tracked.
2. Confirm you are on the **latest** `@reactiive/ennio`.
3. Confirm the environment matches the supported matrix in the
   [README](README.md#getting-started): RN ≥ 0.81 (New Arch / Fabric),
   iOS 17+ simulator, Xcode 16+, Node 18+, `idb-companion` + `fb-idb`
   installed.
4. Make a minimal repro YAML if you can. A 5-line failing flow is
   worth more than a paragraph of description.

## What to include in a bug report

The bug report template asks for these — fill them in:

- Smallest YAML that reproduces the issue.
- Output of `npx ennio test --verbose <flow>.yaml` (last ~50 lines is
  usually enough).
- `xcrun simctl list devices booted` output.
- React Native version, Expo SDK version, Ennio CLI version
  (`bunx ennio version`).
- Screenshot from `/tmp/ennio-shots/<flow>-fail.png` if the flow
  produced one.

## What not to expect

- Help debugging your app's product code that is unrelated to Ennio.
- Android support (see [Limitations](README.md#limitations)).
- Backports of fixes to older versions.
