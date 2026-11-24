import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Chat",
  description: "View an AI chat conversation in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
