import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Content Templates",
  description: "Browse content templates in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
