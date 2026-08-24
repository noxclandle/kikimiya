/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // server/ holds the standalone Socket.io server; it is not part of the Next build.
  outputFileTracingExcludes: { '*': ['./server/**'] },
};

export default nextConfig;
