import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AI Visibility",
  description: "Audit and improve how AI search engines see your websites in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
