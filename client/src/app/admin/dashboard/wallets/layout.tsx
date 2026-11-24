import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Wallets",
  description: "View and manage user credit wallets.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
