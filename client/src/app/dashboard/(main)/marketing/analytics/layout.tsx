import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Marketing Analytics",
  description: "Marketing analytics in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
