import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Brand Toolkits",
  description: "Manage brand identity assets and toolkits.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
