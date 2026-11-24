import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "New Company Profile",
  description: "Create a company profile in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
