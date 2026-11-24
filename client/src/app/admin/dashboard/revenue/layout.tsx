import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Revenue Analytics",
  description: "Track revenue, subscriptions and billing analytics.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
