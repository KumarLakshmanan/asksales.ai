import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Create WhatsApp Campaign",
  description: "Create a WhatsApp outreach campaign in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
