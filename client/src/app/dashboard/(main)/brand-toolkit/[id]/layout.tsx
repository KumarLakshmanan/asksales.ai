import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Brand Toolkit",
  description: "View your brand toolkit in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
