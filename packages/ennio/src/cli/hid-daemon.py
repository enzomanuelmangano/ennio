#!/usr/bin/env python3
"""
Persistent HID injection daemon backed by the python idb client.

The python `idb` CLI eats ~250 ms per invocation booting the
interpreter + loading grpclib + building a gRPC channel — wasted
work when the runner fires 30+ taps per flow. This daemon pays that
cost once, then loops on stdin reading one-line commands and dispatches
them to a long-lived `Client` instance. Each tap is just a gRPC RTT
over the already-warm channel: ~3-8 ms.

Wire protocol (line-delimited, both directions):

  IN   tap <x> <y> <durationMs>
  IN   swipe <x1> <y1> <x2> <y2> <durationMs>
  IN   key <keycode>
  IN   keyrep <keycode> <count>            — N copies, one gRPC call
  IN   text <json-encoded-string>          — JSON string handles spaces / unicode
  IN   exit
  OUT  ok                  — command completed
  OUT  err <message>       — command failed; daemon stays alive

Why batch a `keyrep` op? `eraseText: 50 characters` used to fan out
50 separate `idb ui key 42` subprocess invocations (~160 ms each =
8 s of pure spawn overhead). `keyrep` sends the whole sequence in
one `client.key_sequence` gRPC call — ~50 ms total regardless of
count.

The daemon discovers the companion socket from `IDB_COMPANION` env
var or `/tmp/idb/<UDID>_companion.sock` if the parent passes a UDID
positional. The CLI launches one daemon per booted target and keeps
it alive for the whole `ennio test` session.
"""

import asyncio
import json
import logging
import os
import sys
from pathlib import Path

from idb.common.types import Address, DomainSocketAddress
from idb.grpc.client import Client

# Silence idb's noisy info-level chatter — daemon stdout is the wire
# protocol; any non-`ok` / `err` line would corrupt it.
logging.basicConfig(level=logging.ERROR)


async def main() -> None:
    udid = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("ENNIO_UDID")
    if not udid:
        print("err missing-udid", flush=True)
        sys.exit(2)

    sock_path = Path(f"/tmp/idb/{udid}_companion.sock")
    if not sock_path.exists():
        # No companion running yet — the CLI is expected to run
        # `idb connect <UDID>` once before spawning the daemon. Bail
        # loudly so the parent sees a startup failure.
        print(f"err no-socket {sock_path}", flush=True)
        sys.exit(3)

    address: Address = DomainSocketAddress(path=str(sock_path))

    # `Client.build` is an async context manager that owns the gRPC
    # channel for the duration of the `async with` block. Hold it open
    # for the whole daemon lifetime so per-call cost is just the RTT.
    async with Client.build(address=address, logger=logging.getLogger("ennio")) as client:
        # Signal readiness — parent CLI waits for this line before
        # sending commands.
        print("ready", flush=True)

        # `sys.stdin.readline` is blocking; wrap in
        # `run_in_executor` so the event loop stays responsive (idb's
        # underlying grpclib streams need it).
        loop = asyncio.get_event_loop()
        while True:
            line = await loop.run_in_executor(None, sys.stdin.readline)
            if not line:
                # Parent closed stdin — exit cleanly.
                return
            try:
                await handle(client, line.strip())
            except Exception as e:
                # Per-call failures shouldn't kill the daemon; the
                # parent CLI may retry, or fall back to spawning
                # python idb. Log + continue.
                print(f"err {type(e).__name__}: {e}", flush=True)


async def handle(client: Client, line: str) -> None:
    if not line:
        return
    parts = line.split()
    if not parts:
        return
    op = parts[0]
    # Validate arg counts up front so a malformed line returns a clean
    # "err …" instead of crashing the daemon with IndexError (which the
    # Node parent only sees as an unexpected EOF).
    try:
        if op == "tap":
            # tap <x> <y> [durationMs]
            if len(parts) < 3:
                print("err tap-needs-x-y", flush=True)
                return
            x = int(round(float(parts[1])))
            y = int(round(float(parts[2])))
            dur_ms = float(parts[3]) if len(parts) > 3 else 80.0
            await client.tap(x=x, y=y, duration=dur_ms / 1000.0)
            print("ok", flush=True)
        elif op == "swipe":
            # swipe <x1> <y1> <x2> <y2> [durationMs]
            if len(parts) < 5:
                print("err swipe-needs-x1-y1-x2-y2", flush=True)
                return
            x1 = float(parts[1])
            y1 = float(parts[2])
            x2 = float(parts[3])
            y2 = float(parts[4])
            dur_ms = float(parts[5]) if len(parts) > 5 else 300.0
            await client.swipe(
                p_start=(x1, y1),
                p_end=(x2, y2),
                duration=dur_ms / 1000.0,
            )
            print("ok", flush=True)
        elif op == "key":
            # key <keycode>  — single USB HID key down+up.
            if len(parts) < 2:
                print("err key-needs-keycode", flush=True)
                return
            await client.key(keycode=int(parts[1]))
            print("ok", flush=True)
        elif op == "keyrep":
            # keyrep <keycode> <count>  — N repeated keys in ONE
            # gRPC call. Replaces the eraseText/clearText fan-out
            # of N separate `idb ui key` subprocess spawns
            # (~160 ms each); the whole sequence now lands in ~50 ms.
            if len(parts) < 3:
                print("err keyrep-needs-code-count", flush=True)
                return
            code = int(parts[1])
            count = max(0, int(parts[2]))
            if count > 0:
                await client.key_sequence(key_sequence=[code] * count)
            print("ok", flush=True)
        elif op == "text":
            # text <json-encoded-string>  — JSON string so the
            # payload can carry spaces, unicode, etc. line-safely.
            payload = line[len("text "):].strip() if len(line) > len("text ") else ""
            try:
                text = json.loads(payload)
            except Exception as e:
                print(f"err bad-json-text {e}", flush=True)
                return
            if not isinstance(text, str):
                print("err text-not-string", flush=True)
                return
            if text:
                await client.text(text=text)
            print("ok", flush=True)
        elif op == "exit":
            sys.exit(0)
        else:
            print(f"err unknown-op {op}", flush=True)
    except ValueError as e:
        # float() on non-numeric arg.
        print(f"err bad-arg {e}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
