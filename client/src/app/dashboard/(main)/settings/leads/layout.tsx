import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Lead Settings",
  description: "Configure lead settings in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
