import type { Metadata } from "next";
import { SupportAiShell } from "@/components/support-ai/SupportAiShell";

export const metadata: Metadata = {
  title: "Support AI",
  description: "Configure the AI support assistant, widget, embed code, and quality reports in Ask Sales.",
};

export default function SupportAILayout({ children }: { children: React.ReactNode }) {
  return <SupportAiShell>{children}</SupportAiShell>;
}
