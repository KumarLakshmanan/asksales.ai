import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Master Database",
  description: "Manage the master enriched lead database.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
