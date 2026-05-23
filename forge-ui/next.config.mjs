/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The bridge is on a different port; allow CORS on its origin.
  // FORGE_BRIDGE_URL is exposed to the client via env.
  env: {
    FORGE_BRIDGE_URL: process.env.FORGE_BRIDGE_URL ?? '',
  },
};

export default nextConfig;
