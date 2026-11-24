import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "API Integrations",
  description: "Manage third-party API integrations and credentials.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
