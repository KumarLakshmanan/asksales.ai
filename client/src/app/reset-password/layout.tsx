import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Reset Password",
  description: "Set a new password for your Ask Sales account.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
