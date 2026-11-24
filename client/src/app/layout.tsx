import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { BRAND_NAME, BRAND_URL, COMPANY_NAME } from "@/lib/brand";

export const metadata: Metadata = {
  title: {
    default: `${BRAND_NAME} — Accountable sales and marketing workflows`,
    template: `%s | ${BRAND_NAME}`,
  },
  description:
    "Coordinate lead research, content, outreach, and paid campaigns with visible approvals, durable resources, and provider-backed status.",
  metadataBase: new URL(BRAND_URL),
  keywords: [
    "AI sales automation",
    "marketing automation",
    "lead generation",
    "AI agents",
    "sales platform",
    "outreach automation",
    BRAND_NAME,
    COMPANY_NAME,
  ],
  authors: [{ name: COMPANY_NAME, url: BRAND_URL }],
  creator: BRAND_NAME,
  publisher: BRAND_NAME,
  openGraph: {
    type: "website",
    siteName: BRAND_NAME,
    locale: "en_US",
    url: BRAND_URL,
    title: `${BRAND_NAME} — Accountable sales and marketing workflows`,
    description:
      "Coordinate campaigns with visible approvals, durable resources, and provider-backed status.",
    images: [
      {
        url: `${BRAND_URL}/hero_dashboard_mockup.png`,
        width: 1200,
        height: 630,
        alt: `${BRAND_NAME} dashboard`,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: `${BRAND_NAME} — Accountable sales and marketing workflows`,
    description:
      "Coordinate campaigns with visible approvals, durable resources, and provider-backed status.",
    images: [`${BRAND_URL}/hero_dashboard_mockup.png`],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
    },
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
    apple: "/hero_dashboard_mockup.png",
  },
  other: {
    "fb:app_id": "1373318641307190",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[var(--layer-accessibility)] focus:px-4 focus:py-2 focus:bg-primary focus:text-primary-foreground focus:rounded-lg focus:outline-none focus:ring-2 focus:ring-ring">
          Skip to content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
