import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Outreach Analytics",
  description: "Track outreach campaign performance.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
