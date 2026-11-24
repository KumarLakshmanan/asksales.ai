import type { Metadata } from "next";
import { BRAND_NAME, COMPANY_NAME } from "@/lib/brand";

export const metadata: Metadata = {
  title: "Contact Us",
  description: `Get in touch with the ${BRAND_NAME} team at ${COMPANY_NAME}.`,
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
