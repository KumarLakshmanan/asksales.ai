import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Account settings",
  description: "Manage your Ask Sales account settings.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
