import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "SMS Integration",
  description: "Connect SMS provider to Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
