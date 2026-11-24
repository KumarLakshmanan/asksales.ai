import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Brand Toolkit",
  description: "Manage your brand assets in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
