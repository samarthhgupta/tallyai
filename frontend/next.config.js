/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'export',
  basePath: '/tallyai',
  images: {
    unoptimized: true,
  },
};

module.exports = nextConfig;
