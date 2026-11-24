"use client";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { BusinessInvitations } from "@/components/BusinessInvitations";
import { useAuth } from "@/contexts/AuthContext";

export default function BusinessInvitationsPage() {
  const { hasBusinessProfile } = useAuth();
  return (
    <main
      id="main-content"
      className="flex min-h-svh items-center justify-center bg-background px-4 py-12"
    >
      <div className="w-full max-w-2xl space-y-7">
        <header>
          <p className="text-sm font-medium text-primary">AskSales</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight">
            Join your business
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Accept your invitation to start working with the team.
          </p>
        </header>
        <BusinessInvitations showEmpty />
        <Link
          href={
            hasBusinessProfile
              ? "/dashboard/select-profile"
              : "/setup/business-profile"
          }
          className="inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {hasBusinessProfile
            ? "Choose a business profile"
            : "Create your own business profile"}
        </Link>
      </div>
    </main>
  );
}
