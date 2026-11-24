import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Create LinkedIn Campaign",
  description: "Create a LinkedIn outreach campaign in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
