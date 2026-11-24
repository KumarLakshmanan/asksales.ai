import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Onboarding Setup",
  description: "Complete your Ask Sales onboarding.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
