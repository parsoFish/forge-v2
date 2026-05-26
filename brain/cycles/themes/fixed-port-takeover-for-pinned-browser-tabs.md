---
title: Fixed ports + takeover — let the operator keep one tab pinned
description: >-
  Local dev servers that pick OS-assigned ports break the workflow of
  keeping a single browser tab open across re-runs. Pin known ports and
  kill any prior listeners on startup. The browser tab's WebSocket
  reconnect handles the transient drop.
category: pattern
keywords:
  - dev-server
  - ports
  - operator-workflow
  - forge-ui
  - takeover
  - lsof
created_at: 2026-05-24T00:00:00Z
updated_at: 2026-05-24T00:00:00Z
source_dates:
  - 2026-05-24
---

## The problem

If `forge watch` picks an OS-assigned port (port=0) every run, the
operator has to:

1. Read the chosen URL from stdout
2. Update their browser tab
3. Re-arrange any window layout

That's a paper-cut every time they iterate. Worse, if a prior process
is still on a deterministic port (e.g., Next.js dev on 3000), the new
spawn EADDRINUSEs and dies.

## The fix

**Fixed ports, default to takeover.** Forge's defaults:

- bridge: **4123** (outside common dev-server defaults 3000/5173/8080)
- ui:     **4124**

Re-runs `lsof -tiTCP:<port> -sTCP:LISTEN`, SIGTERMs any matches,
escalates to SIGKILL after 1.5s, waits for the kernel to release the
socket (up to 3s total), then binds. Operator's pinned browser tab
sees its WebSocket close, reconnects via the existing exponential-
backoff loop in [`bridge-client.ts`](../../../forge-ui/lib/bridge-client.ts).

## Why takeover-by-default is safe (for this tool)

The risk: killing some unrelated process that happens to be on 4123 or
4124. Mitigations:

1. The default ports are deliberately outside common dev-server
   defaults so collisions are rare.
2. The operator gets a clear log line:
   `[forge watch] bridge: taking over port 4123 from 2 existing process(es)`.
3. The override flags `--bridge-port` / `--ui-port` route around any
   conflict the operator wants to preserve.

For a personal dev tool this is the right trade-off; for anything
shared, takeover would need to identify "is this my forge process"
before killing.

## The startup race that bit us first

A subtle bug fell out of the work: `http.listen(port, '0.0.0.0')` is
async — `server.address()` returns `null` until the `'listening'` event
fires. Calling `address()` immediately after `listen()` was sometimes
returning the unbound `port: 0`, which the bridge then logged as
"bridge at http://127.0.0.1:0" — and the API route that propagates the
port to the browser saw `0` and gave up.

Fix: `await new Promise((resolve, reject) => { http.once('listening',
resolve); http.once('error', reject); http.listen(port, '0.0.0.0'); })`
before reading `address()`. `startBridge()` became async.

## Related: WSL2 + Windows browser

The fixed-port story interlocks with [[windows-browser-to-wsl-via-window-location]]
— the operator's browser sees `localhost:4124` on Windows, WSL2's
auto-forwarding routes it into WSL, and the bridge-client builds the
bridge URL from `window.location.hostname` so the same forwarding
catches the bridge port too.

## See also

- [[dom-as-metrics-for-headless-driven-uis]] (the other half of the
  watch/operator workflow — they go together)
- [[windows-browser-to-wsl-via-window-location]]
- [`cli/forge-watch.ts:takeoverPort`](../../../cli/forge-watch.ts)
