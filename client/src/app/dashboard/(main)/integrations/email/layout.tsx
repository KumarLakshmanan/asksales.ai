import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Email Integration",
  description: "Configure email integration in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
