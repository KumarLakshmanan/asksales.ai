import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Job Queues",
  description: "Monitor BullMQ job queues and worker health.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
