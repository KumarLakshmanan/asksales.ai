import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Admin Profile",
  description: "View and update your admin profile.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
