import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `pg` is a native/server-only package — keep it out of the bundler so it loads
  // at runtime from node_modules inside the serverless function.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
