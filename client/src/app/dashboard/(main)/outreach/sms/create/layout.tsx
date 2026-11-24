import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Create SMS Campaign",
  description: "Create an SMS outreach campaign in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
