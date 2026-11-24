import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "YouTube Integration",
  description: "Connect YouTube to Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
