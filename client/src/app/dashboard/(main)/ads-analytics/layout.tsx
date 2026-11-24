import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Ad Analytics",
  description: "Track ad campaign performance in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
