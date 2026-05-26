// JS-side entry for the @reactiive/ennio package.
//
// v2 architecture: the in-app dylib (libennio) talks to the CLI over a
// Unix-domain socket, NOT JSI. Apps don't import this module — the
// dylib does all the work via +load and UIKit / Foundation APIs.
//
// This file exists so the npm tarball has a valid `main` entry and so
// the package can be `require()`'d without throwing. Returns trivial
// stubs to keep older code paths that imported `isNativeModuleAvailable`
// or `getEnnioModule` compiling.

export function isNativeModuleAvailable(): boolean {
  // v2 doesn't expose a Nitro module to JS. The dylib is in-process but
  // unreachable from JS — the CLI talks to it via Unix socket from
  // outside the app.
  return false;
}

export function getEnnioModule(): null {
  return null;
}
