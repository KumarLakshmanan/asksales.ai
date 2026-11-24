import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Credit Pricing",
  description: "Configure credit package pricing and tiers.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
