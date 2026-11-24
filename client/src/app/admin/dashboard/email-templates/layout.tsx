import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Email Templates",
  description: "Manage email templates for outreach campaigns.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
