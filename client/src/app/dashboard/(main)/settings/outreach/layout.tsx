import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Outreach Settings",
  description: "Configure outreach settings in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
