import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Account Verification",
  description: "Verify your Ask Sales account.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
