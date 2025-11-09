const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['pdfjs-dist'],
  },
  transpilePackages: ['pdfjs-dist'],
};

export default nextConfig;
