import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pricing Plans",
  description: "View Ask Sales subscription plans.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
