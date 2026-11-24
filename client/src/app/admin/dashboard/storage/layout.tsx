import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Storage Management",
  description: "Manage file storage, uploads and usage.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
