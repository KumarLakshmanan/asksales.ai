import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Dashboard",
  description: "Your Ask Sales dashboard - overview of leads, campaigns, and AI agent activity.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
