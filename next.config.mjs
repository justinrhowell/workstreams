/** @type {import('next').NextConfig} */
// Local-only app: no remote images, no analytics, and a CSP without
// upgrade-insecure-requests (which breaks http://localhost assets).
const nextConfig = {
  // The background service builds and serves from .next-prod, so a dev server
  // (which uses .next) can never overwrite the build it is serving.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  typescript: { ignoreBuildErrors: false },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self' data:",
              "connect-src 'self' ws://localhost:* ws://127.0.0.1:*",
              "object-src 'none'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ]
  },
}

export default nextConfig
