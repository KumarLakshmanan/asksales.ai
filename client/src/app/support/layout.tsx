"use client";

import React from "react";
import { usePathname } from "next/navigation";
import { SupportAuthProvider } from "@/contexts/SupportAuthContext";
import { SupportDashboardLayout } from "@/components/SupportDashboardLayout";

export default function SupportLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isLoginPage = pathname === "/support/login";

  return (
    <SupportAuthProvider>
      {isLoginPage ? (
        children
      ) : (
        <SupportDashboardLayout>
          {children}
        </SupportDashboardLayout>
      )}
    </SupportAuthProvider>
  );
}
