import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Business Profile Setup",
  description: "Set up your business profile in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
