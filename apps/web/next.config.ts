import type { NextConfig } from 'next';

const config: NextConfig = {
  output: process.env.BUILD_TARGET === 'mobile' ? 'export' : undefined,
  images: { unoptimized: true },
  poweredByHeader: false,
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        child_process: false,
        os: false,
        path: false,
      };
    }
    return config;
  },
  turbopack: {
    resolveAlias: {
      fs: { browser: '' },
      net: { browser: '' },
      tls: { browser: '' },
    },
  },
  async rewrites() {
    const apiUrl = process.env.API_URL || (process.env.NODE_ENV === 'development' ? 'http://127.0.0.1:4000' : undefined);
    return apiUrl ? [{ source: '/v1/:path*', destination: `${apiUrl.replace(/\/$/, '')}/v1/:path*` }] : [];
  },
  async headers() {
    return [{ source: '/:path*', headers: [
      {key: 'X-Content-Type-Options', value: 'nosniff'},
      {key: 'Referrer-Policy', value: 'same-origin'},
      {key: 'X-Frame-Options', value: 'DENY'},
      {key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()'}
    ]}];
  }
};

export default config;
