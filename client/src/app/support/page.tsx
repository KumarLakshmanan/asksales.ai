"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSupportAuth } from "@/contexts/SupportAuthContext";
import { Headset } from "lucide-react";

export default function SupportIndexPage() {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useSupportAuth();

  useEffect(() => {
    if (!isLoading) {
      router.push(isAuthenticated ? "/support/tickets" : "/support/login");
    }
  }, [isAuthenticated, isLoading, router]);

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
      <div className="relative">
        <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center animate-pulse">
          <Headset className="w-8 h-8 text-primary" />
        </div>
        <div className="absolute inset-0 border-2 border-primary border-t-transparent rounded-2xl animate-spin" />
      </div>
      <p className="mt-6 text-sm font-bold uppercase tracking-[0.2em] text-muted-foreground animate-pulse">
        Loading Support Portal...
      </p>
    </div>
  );
}
