import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Twitter Integration",
  description: "Connect Twitter/X to Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
