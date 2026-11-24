import type { Metadata } from "next";
import { BRAND_NAME } from "@/lib/brand";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: `${BRAND_NAME} Privacy Policy.`,
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
