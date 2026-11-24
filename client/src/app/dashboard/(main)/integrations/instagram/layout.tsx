import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Instagram Integration",
  description: "Connect Instagram to Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
