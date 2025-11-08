import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config = {}) => {
    config.resolve = config.resolve || {};
    config.resolve.alias = config.resolve.alias || {};
    config.resolve.alias['@'] = path.resolve(__dirname);

    const existingExtensions = config.resolve.extensions || [];
    const requiredExtensions = ['.mjs', '.js'];
    const mergedExtensions = Array.from(
      new Set([...existingExtensions, ...requiredExtensions, '.jsx', '.ts', '.tsx', '.json'])
    );
    config.resolve.extensions = mergedExtensions;

    return config;
  }
};

if (typeof module !== 'undefined') {
  module.exports = nextConfig;
}

export default nextConfig;
