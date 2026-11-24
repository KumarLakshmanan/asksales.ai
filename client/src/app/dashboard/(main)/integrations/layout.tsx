import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Integrations",
  description: "Connect third-party tools to Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
