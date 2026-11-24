import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Invitations",
  description: "Accept invitations to join a business workspace in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
