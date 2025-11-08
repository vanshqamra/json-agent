import { fileURLToPath } from 'url';
import path from 'path';

/** ESM-safe __dirname */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {},
  webpack: (config) => {
    // Ensure @ resolves to project root for both client & server builds
    config.resolve.alias['@'] = path.resolve(__dirname);
    return config;
  }
};

export default nextConfig;
