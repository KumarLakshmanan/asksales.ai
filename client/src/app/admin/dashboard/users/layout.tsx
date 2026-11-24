import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "User Management",
  description: "Manage platform users, roles and permissions.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
