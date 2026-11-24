import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Change Password",
  description: "Update your admin account password.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
