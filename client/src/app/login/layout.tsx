import type { Metadata } from "next";
import { BRAND_NAME } from "@/lib/brand";

export const metadata: Metadata = {
  title: "Sign In or Create Account",
  description: `Sign in or create a ${BRAND_NAME} workspace for your sales and marketing campaigns.`,
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
