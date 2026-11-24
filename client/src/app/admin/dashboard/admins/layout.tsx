import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Admin Management",
  description: "Manage admin accounts and access control.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
