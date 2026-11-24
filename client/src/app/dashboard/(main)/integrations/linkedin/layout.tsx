import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "LinkedIn Integration",
  description: "Connect LinkedIn to Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
