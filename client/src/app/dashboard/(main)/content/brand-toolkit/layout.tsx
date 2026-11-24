import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Brand Toolkit",
  description: "Content brand toolkit in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
