import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Chat",
  description: "Chat with your Ask Sales AI assistant.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
