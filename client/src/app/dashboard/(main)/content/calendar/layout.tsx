import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Content Calendar",
  description: "Plan and schedule your content in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
