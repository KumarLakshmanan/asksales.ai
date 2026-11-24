import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Create Twitter Campaign",
  description: "Create a Twitter outreach campaign in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
