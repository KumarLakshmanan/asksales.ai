import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Notifications",
  description: "View your Ask Sales notifications.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
