import type { Metadata } from "next";
import { BRAND_NAME, COMPANY_NAME } from "@/lib/brand";

export const metadata: Metadata = {
  title: "About Us",
  description: `Learn about ${BRAND_NAME}, the AI-powered sales and marketing platform from ${COMPANY_NAME}.`,
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
