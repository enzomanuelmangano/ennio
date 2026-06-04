// In-house HID client — drop-in replacement for IdbGrpcClient's
// actuation surface (tap / doubleTap / swipe). Instead of a host-side
// idb_companion gRPC stream, it drives the dylib's in-process
// IOHIDEvent injector (hid_down / hid_move / hid_up ops). The events
// enter UIApplication's real touch pipeline, so the app sees a genuine
// finger — same fidelity as idb, zero external dependency.
//
// Coordinates IN are window-space pixels (matching IdbGrpcClient);
// converted to the normalized [0,1] the dylib ops expect via the
// cached screen size.

import { getDylibClient, getScreenSize, trace } from './hid';
import type { EnnioSocketClient } from './socket-client';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class EnnioHidClient {
  constructor(private readonly udid: string) {}

  private dy(): EnnioSocketClient {
    return getDylibClient(this.udid);
  }

  private async norm(x: number, y: number): Promise<{ nx: number; ny: number }> {
    const { w, h } = await getScreenSize(this.udid);
    return {
      nx: Math.max(0, Math.min(1, x / w)),
      ny: Math.max(0, Math.min(1, y / h)),
    };
  }

  private async op(name: string, nx: number, ny: number): Promise<void> {
    const r = await this.dy().call(name, { x: nx, y: ny });
    if (!r.ok || !(r.data && (r.data as { ok?: boolean }).ok)) {
      throw new Error(`${name} failed: ${r.err ?? 'ok:false'}`);
    }
  }

  /** Single tap: Down → hold → Up at the same point. */
  async tap(x: number, y: number, holdSec = 0.05): Promise<void> {
    const { nx, ny } = await this.norm(x, y);
    trace(`[enniohid] tap n=(${nx.toFixed(4)},${ny.toFixed(4)}) hold=${holdSec}s`);
    await this.op('hid_down', nx, ny);
    await sleep(Math.max(20, holdSec * 1000));
    await this.op('hid_up', nx, ny);
  }

  /** Double tap on one sequence: Down/Up ×2 with a tight gap so it
   *  lands inside UITapGestureRecognizer's ~350ms double-tap window. */
  async doubleTap(x: number, y: number): Promise<void> {
    const { nx, ny } = await this.norm(x, y);
    trace(`[enniohid] double-tap n=(${nx.toFixed(4)},${ny.toFixed(4)})`);
    await this.op('hid_down', nx, ny);
    await sleep(40);
    await this.op('hid_up', nx, ny);
    await sleep(90);
    await this.op('hid_down', nx, ny);
    await sleep(40);
    await this.op('hid_up', nx, ny);
  }

  /** Swipe: Down at start, interpolated Moves, Up at end. The Move
   *  cadence + count give the gesture a real velocity so scroll
   *  momentum, RNGH pan, and page-snap behave like a finger drag. */
  async swipe(x1: number, y1: number, x2: number, y2: number, durationSec: number): Promise<void> {
    const from = await this.norm(x1, y1);
    const to = await this.norm(x2, y2);
    const durMs = Math.max(50, durationSec * 1000);
    const steps = Math.max(8, Math.round(durMs / 16));
    const stepMs = durMs / steps;
    trace(
      `[enniohid] swipe n=(${from.nx.toFixed(4)},${from.ny.toFixed(4)})→(${to.nx.toFixed(4)},${to.ny.toFixed(4)}) dur=${durMs}`,
    );
    await this.op('hid_down', from.nx, from.ny);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await this.op('hid_move', from.nx + (to.nx - from.nx) * t, from.ny + (to.ny - from.ny) * t);
      await sleep(stepMs);
    }
    await this.op('hid_up', to.nx, to.ny);
  }
}
