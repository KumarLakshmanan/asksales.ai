import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Business Profile",
  description: "Your business profile, brand details and workspace setup in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
