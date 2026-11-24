import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Content Templates",
  description: "Create and manage reusable content templates.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
