import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Staff",
  description: "Invite staff and manage access to this business profile in Ask Sales.",
};

export default function StaffLayout({ children }: { children: React.ReactNode }) {
  return children;
}
