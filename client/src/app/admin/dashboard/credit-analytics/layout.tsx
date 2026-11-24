import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Credit Analytics",
  description: "Analyse credit allocation and consumption trends.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
