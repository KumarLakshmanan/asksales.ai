import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AI Agents",
  description: "Explore the AI agents powering Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
