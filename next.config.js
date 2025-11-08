// next.config.js  (ESM-safe alias)
import path from 'path';
import { fileURLToPath } from 'url';

/** ESM __dirname shim */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    // Make "@" point to the project root
    config.resolve.alias['@'] = path.resolve(__dirname);
    return config;
  },
};

export default nextConfig;
