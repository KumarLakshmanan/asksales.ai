import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Billing Analytics",
  description: "Analyse your usage and spending.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
