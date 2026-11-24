import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "WhatsApp Integration",
  description: "Connect WhatsApp to Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
