import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Assistant settings",
  description: "Configure an outreach assistant in Ask Sales.",
};

export default function AssistantSettingsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
