import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "DM Templates",
  description: "Manage direct message templates for social channels.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
