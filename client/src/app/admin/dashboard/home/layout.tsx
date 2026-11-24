import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Dashboard",
  description: "Admin dashboard with key metrics.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
