import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Campaign Management",
  description: "Oversee all user campaigns and outreach activity.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
