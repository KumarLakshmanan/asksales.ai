import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Lead Flow",
  description: "Manage visual lead flow workflows.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
