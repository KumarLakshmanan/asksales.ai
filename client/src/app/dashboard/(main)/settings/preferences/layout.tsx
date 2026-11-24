import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Preferences",
  description: "Manage your preferences in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
