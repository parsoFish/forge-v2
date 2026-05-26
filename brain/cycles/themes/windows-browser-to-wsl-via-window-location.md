---
title: For browser↔WSL connectivity, build URLs from `window.location.hostname`
description: >-
  A Windows browser hitting a WSL2-hosted dev server can only reach
  ports via `localhost` (auto-forwarded into WSL) — `127.0.0.1` is the
  Windows loopback, not the WSL host. When a server tells the client
  where to find a sibling service, return the **port** (or a relative
  path) and let the client build the URL from `window.location.hostname`
  so the same forwarding catches every service.
category: pattern
keywords:
  - wsl2
  - windows
  - browser
  - networking
  - localhost
  - forge-ui
  - port-forwarding
created_at: 2026-05-24T00:00:00Z
updated_at: 2026-05-24T00:00:00Z
source_dates:
  - 2026-05-24
---

## The trap

The operator runs forge in WSL2 and opens forge-ui in their Windows
browser. Forge has two processes:

- Next.js dev server on port 4124
- WebSocket bridge on port 4123

Both bind to `0.0.0.0` (all interfaces) inside WSL. From the Windows
browser:

- `http://localhost:4124` works — WSL2's auto-port-forwarding sees the
  bind on the WSL side and exposes it on the Windows side at
  `localhost:4124`.
- `http://localhost:4123` works for the same reason.
- `http://127.0.0.1:4123` **fails** — 127.0.0.1 from the Windows browser
  means the Windows loopback, not the WSL host. Nothing's listening on
  Windows.

## The forge-ui bug

The Next.js API route `/api/forge-config` originally returned the
absolute bridge URL `http://127.0.0.1:4123`. The route reads
`process.env.FORGE_BRIDGE_URL` which the watch process sets — and from
the watch process's POV (inside WSL), 127.0.0.1 is correct. But the
browser is in Windows-land and the URL is meaningless there.

Symptom: page hung on "bridge ○ reconnecting" forever; HTTP fetches +
WebSocket all silently failed.

## The fix

Return the **port** (not the full URL) and have the client compose:

```ts
// API route (server-side):
const port = Number(new URL(process.env.FORGE_BRIDGE_URL).port);
return Response.json({ bridgePort: port });

// Client (browser):
const { bridgePort } = await fetch('/api/forge-config').then((r) => r.json());
const base = `${window.location.protocol}//${window.location.hostname}:${bridgePort}`;
const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
```

Now the WS connects to `ws://localhost:4123/ws` from the Windows
browser, which WSL2 forwards to the bridge inside WSL. Same trick
applies to any browser↔sibling-service composition under WSL2 / any
other localhost-forwarding scheme (docker-desktop's `host.docker.internal`,
SSH `LocalForward`, etc.).

## Generalises beyond WSL

The pattern is "give the browser the discriminator it needs, let it
build the URL from its own origin". This works for:

- **Reverse proxies**: the API tells the client `service: 'foo'`, the
  client hits `/foo/api/whatever` on the same origin.
- **Subdomain routing**: API returns `subdomain: 'foo'`, client builds
  `https://foo.${window.location.host.split('.').slice(1).join('.')}`.
- **Tunnels**: any time the operator might be accessing the dev server
  through a tunnel with a different hostname than what the dev process
  sees locally.

## Diagnostic surface

When the bridge URL goes wrong, the operator now sees:

- The connection-state badge in the page header turns red
  (`● open` → `○ no-bridge` / `◌ reconnecting`)
- A monospace footer next to the badge shows the resolved bridge URL
  the browser is trying — they can copy/paste it into a new tab to
  confirm whether the port itself is reachable.

Also exposed via `data-bridge-url` on the root `<main>` (see
[[dom-as-metrics-for-headless-driven-uis]]) for headless probes.

## See also

- [[fixed-port-takeover-for-pinned-browser-tabs]]
- [`forge-ui/lib/bridge-client.ts:resolveBridgeUrl`](../../../forge-ui/lib/bridge-client.ts)
- [`forge-ui/app/api/forge-config/route.ts`](../../../forge-ui/app/api/forge-config/route.ts)
