import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Storage",
  description: "Manage file storage in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
