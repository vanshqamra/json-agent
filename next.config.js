// next.config.js (ESM-safe alias for "@")
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {},
  webpack: (config) => {
    // Hard alias so "@/…" always points to project root
    config.resolve.alias = config.resolve.alias || {};
    config.resolve.alias["@"] = path.resolve(__dirname, ".");
    return config;
  },
};

export default nextConfig;
