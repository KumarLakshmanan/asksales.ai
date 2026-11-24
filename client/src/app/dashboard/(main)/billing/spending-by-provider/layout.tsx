import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Spending by Provider",
  description: "View your AI credit spending broken down by provider in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
