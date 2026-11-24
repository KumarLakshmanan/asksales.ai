import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Meta Integration",
  description: "Connect Meta to Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
