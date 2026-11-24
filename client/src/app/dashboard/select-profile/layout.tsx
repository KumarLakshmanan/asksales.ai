import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Select Business Profile",
  description: "Choose which business profile to work in.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
