/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    domains: ['localhost'],
  },
  // Cloudflare Pages handles output automatically
  output: undefined,
};

module.exports = nextConfig;
