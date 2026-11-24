import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Proposals",
  description: "Create, send, and track proposals and your product catalog in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
