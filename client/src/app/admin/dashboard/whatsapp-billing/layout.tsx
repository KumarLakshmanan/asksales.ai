import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "WhatsApp Billing",
  description: "Meta credit line, WhatsApp rate cards, billed accounts and reconciliation.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
