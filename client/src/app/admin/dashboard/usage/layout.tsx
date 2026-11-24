import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Usage Analytics",
  description: "Monitor API usage, token consumption and costs.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
