import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Social Posts",
  description: "Manage social media posts in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
