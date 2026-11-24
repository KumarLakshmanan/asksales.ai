import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "API Pricing",
  description: "Manage per-model API pricing and cost overrides.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
