"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Building2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import api from "@/lib/api";
import {
  openBusinessDashboard,
  selectBusinessProfile,
} from "@/lib/business-profile";
import type { BusinessProfileSummary } from "@/hooks/use-business-profiles";

export type BusinessInvitation = {
  id: number;
  businessProfileId: number;
  businessProfileName: string;
  email: string;
  role: "billing_admin" | "member";
};

export function BusinessInvitations({
  showEmpty = false,
}: {
  showEmpty?: boolean;
}) {
  const auth = useAuth();
  const cache = useQueryClient();
  const [accepting, setAccepting] = useState<number | null>(null);
  const [error, setError] = useState("");
  const invitations = useQuery({
    queryKey: ["business-profile-invitations", auth.user?.id],
    queryFn: () =>
      api.get<{ invitations: BusinessInvitation[] }>(
        "/api/settings/business-profiles/invitations",
      ),
    enabled: !!auth.user && !auth.isLoading,
    retry: 1,
  });
  const accept = async (id: number) => {
    setAccepting(id);
    setError("");
    try {
      const result = await api.post<{
        businessProfile: BusinessProfileSummary;
      }>(`/api/settings/business-profiles/invitations/${id}/accept`, {});
      if (!Number.isSafeInteger(result.businessProfile?.id) || result.businessProfile.id <= 0) {
        throw new Error('The business is unavailable. Refresh your invitations and ask its owner for help.');
      }
      await cache.cancelQueries();
      selectBusinessProfile(result.businessProfile.id);
      cache.clear();
      await auth.checkAuth();
      openBusinessDashboard();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Invitation could not be accepted. Try again.",
      );
      await invitations.refetch();
      setAccepting(null);
    }
  };
  if (invitations.isLoading)
    return showEmpty ? (
      <p
        role="status"
        className="py-8 text-center text-sm text-muted-foreground"
      >
        Checking your invitations…
      </p>
    ) : null;
  if (invitations.isError)
    return (
      <div
        role="alert"
        className="rounded-xl border border-border bg-card p-5 text-sm"
      >
        <p>Your business invitations could not be loaded.</p>
        <Button
          variant="outline"
          className="mt-3"
          onClick={() => void invitations.refetch()}
        >
          Try again
        </Button>
      </div>
    );
  const items = invitations.data?.invitations ?? [];
  if (!items.length && !showEmpty) return null;
  return (
    <section
      aria-labelledby="business-invitations-title"
      className="rounded-2xl border border-primary/25 bg-primary/[0.035] p-5 sm:p-6"
    >
      <div className="flex items-start gap-3">
        <Mail className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
        <div>
          <h2 id="business-invitations-title" className="text-lg font-semibold">
            Business invitations
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Join the business you work with. Its profile, tools and staff are
            your workspace.
          </p>
        </div>
      </div>
      {error && (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {items.length ? (
        <ul className="mt-5 divide-y divide-border">
          {items.map((invitation) => (
            <li
              key={invitation.id}
              className="flex flex-wrap items-center justify-between gap-4 py-4 first:pt-0 last:pb-0"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-background text-primary">
                  <Building2 className="h-5 w-5" aria-hidden />
                </span>
                <div className="min-w-0">
                  <h3 className="break-words text-sm font-semibold">
                    {invitation.businessProfileName}
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {invitation.role === "billing_admin"
                      ? "Billing admin"
                      : "Staff member"}{" "}
                    · {invitation.email}
                  </p>
                </div>
              </div>
              <Button
                loading={accepting === invitation.id}
                loadingText="Join business"
                disabled={accepting !== null && accepting !== invitation.id}
                onClick={() => void accept(invitation.id)}
                aria-label={`Join ${invitation.businessProfileName}`}
              >
                <ArrowRight className="mr-2 h-4 w-4" aria-hidden />
                Join business
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-5 text-sm leading-6 text-muted-foreground">
          No pending invitations for {auth.user?.email}. Ask the business owner
          to invite this email address, then refresh.
        </p>
      )}
      {!items.length && (
        <Button
          variant="outline"
          className="mt-4"
          disabled={invitations.isFetching}
          onClick={() => void invitations.refetch()}
        >
          Refresh invitations
        </Button>
      )}
    </section>
  );
}
