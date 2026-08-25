/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship TypeScript source, so Next compiles them itself.
  transpilePackages: [
    '@counterparty/core',
    '@counterparty/agents',
    '@counterparty/llm',
    '@counterparty/rails',
    '@counterparty/config',
    '@counterparty/demo',
  ],
};

export default nextConfig;
