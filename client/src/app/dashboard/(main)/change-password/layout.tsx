import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Change Password",
  description: "Update your account password in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
