import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Credit Events",
  description: "View credit transaction events and history.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
