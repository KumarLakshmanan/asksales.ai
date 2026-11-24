import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Create Instagram Campaign",
  description: "Create an Instagram outreach campaign in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
