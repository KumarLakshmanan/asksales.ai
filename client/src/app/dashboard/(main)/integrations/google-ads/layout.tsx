import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Google Ads Integration",
  description: "Connect Google Ads to Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
