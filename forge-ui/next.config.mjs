/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Bridge URL is resolved at runtime via /api/forge-config so the value
  // doesn't have to be present when `next dev` starts. See lib/bridge-client.ts.
};

export default nextConfig;
