import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Profile",
  description: "View and update your Ask Sales profile.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
