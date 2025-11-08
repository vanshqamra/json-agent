// next.config.js (ESM-safe)
import { fileURLToPath } from 'url';
import path from 'path';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // If you previously added a webpack callback only for __dirname or aliases, simplify it.
  webpack: (config) => {
    // Ensure .js is resolvable without extension if we ever omit it:
    config.resolve.extensions = ['.js', '.jsx', '.ts', '.tsx', '.json'];
    return config;
  },
  // If we ever need Node runtime for API routes using Node libs, it’s fine—app routes can set runtime per file.
};

export default nextConfig;

// Helper (if needed elsewhere)
export const __filename = fileURLToPath(import.meta.url);
export const __dirname = path.dirname(__filename);
