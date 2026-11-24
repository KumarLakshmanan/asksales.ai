import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Business Categories",
  description: "Configure business category taxonomy.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
