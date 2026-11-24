import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Saved Templates",
  description: "Browse your saved templates in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
