import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "System Logs",
  description: "View application and error logs.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
