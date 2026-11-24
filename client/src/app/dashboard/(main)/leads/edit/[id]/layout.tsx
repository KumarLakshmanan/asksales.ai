import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Edit Lead",
  description: "Update lead details in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
