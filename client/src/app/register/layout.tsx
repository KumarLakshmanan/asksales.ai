import type { Metadata } from "next";
import { BRAND_NAME } from "@/lib/brand";

export const metadata: Metadata = {
  title: "Create Account",
  description: `Create your free ${BRAND_NAME} account and start automating your sales and marketing with AI agents.`,
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
