import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Transactions",
  description: "View your billing transaction history.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
