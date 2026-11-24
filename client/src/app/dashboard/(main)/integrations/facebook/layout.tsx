import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Facebook Integration",
  description: "Connect Facebook to Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
