import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Content Calendar",
  description: "Manage scheduled content and publishing plans.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
