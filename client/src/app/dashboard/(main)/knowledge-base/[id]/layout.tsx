import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Knowledge Base Article",
  description: "View a knowledge base article in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
