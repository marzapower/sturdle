import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The engine and the adapter are plain Node packages (they read SQL files from disk and hold a
  // pg pool): keep them out of the bundle so the server requires them from node_modules.
  serverExternalPackages: ["@sturdle/engine", "@sturdle/postgres", "pg"],
};

export default nextConfig;
