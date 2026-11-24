import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Conversations",
  description: "AI-powered conversations in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
