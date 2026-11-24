import type { NextConfig } from "next";
import { AtomicDevelopmentAssetsPlugin } from "./config/atomic-development-assets";
import { supportWidgetHeaders } from "./config/support-widget-headers";

const isProduction = process.env.NODE_ENV === "production";

const configuredWebSocketSource = (() => {
  const configured = process.env.NEXT_PUBLIC_WS_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
})();

const configuredApiSource = (() => {
  const configured = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
})();

const connectSources = [
  "'self'",
  "wss://asksales.ai",
  "https://asksales.ai",
  "https://*.asksales.ai",
  "https://*.razorpay.com",
  "https://accounts.google.com",
  ...(configuredApiSource ? [configuredApiSource] : []),
  ...(configuredWebSocketSource ? [configuredWebSocketSource] : []),
  ...(isProduction ? [] : ["ws://localhost:*", "http://localhost:*"]),
];

const nextConfig: NextConfig = {
  // Allows an isolated audit/dev server to run alongside the primary dev server.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  output: "standalone",
  // The frontend image contains app sources. Keep cross-workspace test imports
  // in the separate full-workspace `typecheck` command, not the app build.
  typescript: {
    tsconfigPath: isProduction ? "tsconfig.build.json" : "tsconfig.json",
  },
  turbopack: {
    // Shared ESM modules retain .js specifiers for the compiled server.
    resolveAlias: {
      "./blogContent.js": "../shared/blogContent.ts",
      "./emailTemplateSections.js": "../shared/emailTemplateSections.ts",
      "./templateVariables.js": "../shared/templateVariables.ts",
      "./outreachCompose.js": "../shared/outreachCompose.ts",
    },
  },
  // Website analysis crawls multiple pages and calls AI before returning.
  experimental: {
    proxyTimeout: 300_000,
    // Isolated preview servers use disposable in-memory compilation caches.
    ...(process.env.NEXT_DIST_DIR ? { turbopackFileSystemCacheForDev: false } : {}),
    // Keep compilation isolated even with our custom webpack callback, and
    // bound page-generation concurrency for the full multi-workspace build.
    webpackBuildWorker: true,
    cpus: 1,
    // Shared modules keep .js imports for the server's compiled ESM output.
    // Resolve those imports to their TypeScript sources when bundling the client.
    extensionAlias: { ".js": [".ts", ".tsx", ".js"] },
  },
  webpack(config, { dev }) {
    // The production webpack cache can exceed 1.5 GB in this workspace and is
    // fully disposable. Avoid persisting it so builds cannot starve the API of
    // disk space and crash authenticated chat sessions with ENOSPC.
    if (!dev) config.cache = false;
    if (dev) config.plugins.push(new AtomicDevelopmentAssetsPlugin());
    return config;
  },
  // Security headers for all Next.js responses
  async headers() {
    const securityHeaders = [
          // Prevent this application from being framed by other origins.
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          // Prevent MIME type sniffing
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Referrer policy — don't leak full URL in Referer header
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Permissions policy — disable unnecessary browser APIs
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          // Basic XSS protection header (legacy browsers)
          { key: "X-XSS-Protection", value: "1; mode=block" },
          // Next emits inline bootstrap scripts. Development additionally needs
          // eval for source maps/HMR; production does not.
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              `script-src 'self' 'unsafe-inline' https://*.razorpay.com https://accounts.google.com/gsi/client${isProduction ? "" : " 'unsafe-eval'"}`,
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style",
              "font-src 'self' data: https://fonts.gstatic.com",
              `img-src 'self' data: blob: https:${isProduction ? "" : " http://localhost:*"}`,
              `connect-src ${[...new Set(connectSources)].join(" ")}`,
              "media-src 'self' blob: data: https:",
              "worker-src 'self' blob:",
              "frame-src 'self' blob: https://*.razorpay.com https://accounts.google.com/gsi/",
              "frame-ancestors 'self'",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
    ];
    return [
      { source: "/:path((?!support-widget/).*)", headers: securityHeaders },
      { source: "/support-widget/:path*", headers: supportWidgetHeaders(securityHeaders) },
      {
        source: "/login",
        headers: [{ key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" }],
      },
    ];
  },
  async redirects() {
    return [
      { source: "/dashboard/documentation/:path*", destination: "/documentation/:path*", permanent: true },
      {
        source: "/favicon.ico",
        destination: "/favicon.svg",
        permanent: true,
      },
      {
        source: "/dashboard/ads-campaigns",
        destination: "/dashboard/ads?tab=campaigns",
        permanent: false,
      },
      {
        source: "/dashboard/ads-analytics",
        has: [
          {
            type: "query",
            key: "tab",
            value:
              "(?<detail>performance|units|recommendations|history|evidence|policy)",
          },
        ],
        destination: "/dashboard/ads?tab=overview&detail=:detail",
        permanent: false,
      },
      {
        source: "/dashboard/ads-analytics",
        destination: "/dashboard/ads?tab=overview",
        permanent: false,
      },
      {
        source: "/dashboard/content/approvals",
        destination: "/dashboard/content/templates",
        permanent: false,
      },
      {
        source: "/dashboard/content",
        destination: "/dashboard/content/templates",
        permanent: false,
      },
      {
        source: "/dashboard/content/templates",
        destination: "/dashboard/saved-templates",
        permanent: false,
      },
      {
        source: "/dashboard/outreach",
        destination: "/dashboard/outreach/inbox",
        permanent: false,
      },
      {
        source: "/dashboard/outreach/twitter/:path*",
        destination: "/dashboard/home",
        permanent: false,
      },
      {
        source: "/dashboard/outreach/linkedin/:path*",
        destination: "/dashboard/home",
        permanent: false,
      },
      {
        source: "/dashboard/integrations/twitter/:path*",
        destination: "/dashboard/home",
        permanent: false,
      },
      {
        source: "/dashboard/integrations/linkedin/:path*",
        destination: "/dashboard/home",
        permanent: false,
      },
    ];
  },
  // Proxy API requests and uploads to the backend server
  async rewrites() {
    const backendUrl = (
      process.env.BACKEND_URL ||
      process.env.NEXT_PUBLIC_API_URL ||
      "http://localhost:8080"
    ).replace(/\/+$/, "");
    return [
      {
        source: "/api/:path*",
        destination: `${backendUrl}/api/:path*`,
      },
      {
        source: "/uploads/:path*",
        destination: `${backendUrl}/uploads/:path*`,
      },
    ];
  },
  images: {
    remotePatterns: [
      // LinkedIn profile images
      { protocol: "https", hostname: "*.licdn.com" },
      { protocol: "https", hostname: "media.licdn.com" },
      // Instagram / Facebook / Meta CDN
      { protocol: "https", hostname: "*.cdninstagram.com" },
      { protocol: "https", hostname: "*.fbcdn.net" },
      { protocol: "https", hostname: "*.instagram.com" },
      // Google / YouTube
      { protocol: "https", hostname: "*.googleusercontent.com" },
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
      // Twitter / X
      { protocol: "https", hostname: "pbs.twimg.com" },
      // Generic cloud storage
      { protocol: "https", hostname: "storage.googleapis.com" },
      { protocol: "https", hostname: "*.s3.amazonaws.com" },
      { protocol: "https", hostname: "*.amazonaws.com" },
      // Gravatar / avatars
      { protocol: "https", hostname: "www.gravatar.com" },
      // Clearbit / enrichment logos
      { protocol: "https", hostname: "logo.clearbit.com" },
      // Local development only; never allow the production image optimizer to
      // fetch arbitrary localhost resources.
      ...(!isProduction
        ? [{ protocol: "http" as const, hostname: "localhost" }]
        : []),
    ],
  },
};

export default nextConfig;
