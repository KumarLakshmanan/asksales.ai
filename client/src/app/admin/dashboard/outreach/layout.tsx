import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Outreach Management",
  description: "Monitor outreach sequences and delivery metrics.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
