/**
 * Runtime config endpoint — exposes the bridge URL the client should
 * talk to. Read from process.env at REQUEST time (not build time),
 * which is what we need because `forge watch` picks an OS-assigned
 * bridge port and `next.config.mjs`'s `env` block bakes values into
 * the bundle at startup — fragile across dev reloads.
 *
 * The browser hits this endpoint on mount, gets the bridge URL, and
 * caches it for the WS + fetch calls.
 */

export const dynamic = 'force-dynamic';

export function GET() {
  const bridgeUrl = process.env.FORGE_BRIDGE_URL ?? '';
  return Response.json({ bridgeUrl });
}
