import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Company Profile",
  description: "Manage your company profile in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
