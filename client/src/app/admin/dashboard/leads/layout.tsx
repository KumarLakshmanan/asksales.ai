import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Lead Database",
  description: "Browse and manage the master lead database.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
