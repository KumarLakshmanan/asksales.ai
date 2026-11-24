import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Hotel",
  description: "Hotel bookings and availability in Ask Sales.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
