import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Knowledge Base",
  description: "Manage your knowledge base in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
