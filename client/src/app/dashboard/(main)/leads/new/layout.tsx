import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "New Lead",
  description: "Create a new lead in your Ask Sales pipeline.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
