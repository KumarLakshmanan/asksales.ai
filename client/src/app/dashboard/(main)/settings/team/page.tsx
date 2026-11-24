"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Loader2,
  Mail,
  ShieldCheck,
  UserPlus,
  Users,
} from "lucide-react";
import api from "@/lib/api";
import { BUSINESS_PROFILE_HEADER } from "@/lib/business-profile";
import {
  businessProfileName,
  useBusinessProfiles,
} from "@/hooks/use-business-profiles";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";

export type BusinessStaffMember = {
  id: number;
  userId: number | null;
  email: string;
  role: "owner" | "billing_admin" | "member";
  status: "active" | "invited" | "revoked";
};
const roleLabel = (role: BusinessStaffMember["role"]) =>
  role === "owner"
    ? "Owner"
    : role === "billing_admin"
      ? "Billing admin"
      : "Staff member";
const selectClass =
  "min-h-11 rounded-lg border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export default function BusinessStaffPage() {
  const { user } = useAuth();
  const profiles = useBusinessProfiles();
  const profile = profiles.activeProfile;
  const businessId = profile?.id;
  const owner = profile?.role === "owner" && profile.canManageTeam !== false;
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"billing_admin" | "member">("member");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [remove, setRemove] = useState<BusinessStaffMember | null>(null);
  const members = useQuery({
    queryKey: ["business-profile-staff", user?.id, businessId],
    queryFn: () =>
      api.get<{ members: BusinessStaffMember[] }>(
        `/api/settings/business-profiles/${businessId}/members`,
        { headers: { [BUSINESS_PROFILE_HEADER]: String(businessId) } },
      ),
    enabled: !!businessId && !profiles.isLoading,
    retry: 1,
  });
  const run = async (action: () => Promise<unknown>, success: string) => {
    if (!owner || !businessId) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["business-profile-staff"] }),
        cache.invalidateQueries({ queryKey: ["subscription"] }),
        cache.invalidateQueries({ queryKey: ["business-profiles"] }),
      ]);
      setNotice(success);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Staff could not be updated. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  if (profiles.isLoading)
    return <LoadingState size="page" label="Loading business staff…" />;
  if (profiles.isError)
    return (
      <div role="alert" className="p-8">
        <p>Business profiles could not be loaded.</p>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => void profiles.refetch()}
        >
          Try again
        </Button>
      </div>
    );
  if (!profile)
    return (
      <div className="p-8">
        <h1 className="text-2xl font-semibold">Choose a business first</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Staff belong to the business profile you select.
        </p>
        <Button asChild className="mt-5">
          <Link href="/dashboard/select-profile">Choose business profile</Link>
        </Button>
      </div>
    );
  const options = {
    headers: { [BUSINESS_PROFILE_HEADER]: String(businessId) },
  };
  const list = members.data?.members ?? [];
  const currentMembers = list.filter((member) => member.status !== "revoked");
  const revoked = list.filter((member) => member.status === "revoked");
  return (
    <div className="mx-auto w-full max-w-5xl space-y-7 px-4 py-6 sm:px-6 lg:py-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-primary">
            {businessProfileName(profile)}
          </p>
          <h1 className="mt-2 flex items-center gap-3 text-3xl font-semibold tracking-tight">
            <Users className="h-7 w-7 text-primary" aria-hidden />
            Staff
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
            Everyone here works in this business profile.{" "}
            {owner
              ? "Invite staff, choose their role and manage access in one place."
              : "The business owner manages invitations and roles."}
          </p>
        </div>
        <Link
          href="/dashboard/invitations"
          className="inline-flex min-h-11 items-center gap-2 text-sm text-primary hover:underline"
        >
          <Mail className="h-4 w-4" aria-hidden />
          Your invitations
        </Link>
      </header>
      {error && <Callout tone="danger">{error}</Callout>}
      {notice && (
        <Callout tone="success" announce icon={Check}>
          {notice}
        </Callout>
      )}
      {owner && (
        <section
          className="rounded-2xl border border-primary/20 bg-primary/[0.035] p-5 sm:p-6"
          aria-labelledby="invite-staff-heading"
        >
          <h2
            id="invite-staff-heading"
            className="flex items-center gap-2 text-lg font-semibold"
          >
            <UserPlus className="h-5 w-5 text-primary" aria-hidden />
            Invite staff
          </h2>
          <form
            className="mt-5 grid items-end gap-4 sm:grid-cols-[1fr_180px_auto]"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await api.post(
                  `/api/settings/business-profiles/${businessId}/members`,
                  { email: email.trim(), role },
                  options,
                );
                setEmail("");
              }, "Invitation created. Your colleague can accept it from Your invitations when signed in with this email.");
            }}
          >
            <div>
              <Label htmlFor="staff-email">Email address</Label>
              <Input
                id="staff-email"
                type="email"
                required
                value={email}
                disabled={busy}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="colleague@company.com"
                className="mt-2 min-h-11 bg-background"
              />
            </div>
            <div>
              <Label htmlFor="staff-role">Role</Label>
              <select
                id="staff-role"
                className={`${selectClass} mt-2 w-full`}
                value={role}
                disabled={busy}
                onChange={(event) => setRole(event.target.value as typeof role)}
              >
                <option value="member">Staff member</option>
                <option value="billing_admin">Billing admin</option>
              </select>
            </div>
            <Button disabled={busy || !email.trim()} className="min-h-11">
              {busy && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              )}
              Create invitation
            </Button>
            <p className="text-xs leading-5 text-muted-foreground sm:col-span-3">
              Invitations appear inside AskSales. No email is sent. Share{" "}
              <Link
                href="/dashboard/invitations"
                className="font-medium text-primary underline"
              >
                the invitations page
              </Link>{" "}
              with your colleague. Pending invitations count toward your staff
              allowance.
            </p>
          </form>
        </section>
      )}
      <section
        className="overflow-hidden rounded-2xl border border-border bg-card"
        aria-labelledby="business-staff-heading"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-6">
          <h2 id="business-staff-heading" className="font-semibold">
            Business staff
          </h2>
          {!members.isLoading && !members.isError && (
            <p className="text-xs text-muted-foreground">
              {
                currentMembers.filter((member) => member.status === "active")
                  .length
              }{" "}
              active ·{" "}
              {
                currentMembers.filter((member) => member.status === "invited")
                  .length
              }{" "}
              invited
            </p>
          )}
        </div>
        {members.isLoading ? (
          <LoadingState size="section" label="Loading staff…" />
        ) : members.isError ? (
          <div role="alert" className="p-6 text-sm">
            <p>
              Staff could not be loaded for this business. Your access may have
              changed.
            </p>
            <Button
              variant="outline"
              className="mt-3"
              onClick={() => void members.refetch()}
            >
              Try again
            </Button>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {currentMembers.map((member) => (
              <li
                key={member.id}
                className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 sm:px-6"
              >
                <div className="min-w-0">
                  <p className="break-all text-sm font-medium">
                    {member.email}
                    {member.userId === user?.id && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        You
                      </span>
                    )}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {member.status === "invited"
                      ? "Invitation pending"
                      : "Active"}
                    {member.role === "owner" && " · Business owner"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {owner && member.role !== "owner" ? (
                    <>
                      <select
                        aria-label={`Role for ${member.email}`}
                        className={selectClass}
                        disabled={busy}
                        value={member.role}
                        onChange={(event) =>
                          void run(
                            () =>
                              api.patch(
                                `/api/settings/business-profiles/${businessId}/members/${member.id}`,
                                { role: event.target.value },
                                options,
                              ),
                            "Staff role updated.",
                          )
                        }
                      >
                        <option value="member">Staff member</option>
                        <option value="billing_admin">Billing admin</option>
                      </select>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setRemove(member)}
                        aria-label={`Remove ${member.email}`}
                      >
                        Remove
                      </Button>
                    </>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs font-medium">
                      {member.role === "owner" && (
                        <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                      )}
                      {roleLabel(member.role)}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {!!revoked.length && (
          <details className="border-t border-border px-5 py-4 sm:px-6">
            <summary className="cursor-pointer text-sm text-muted-foreground">
              Removed access ({revoked.length})
            </summary>
            <ul className="mt-3 space-y-3">
              {revoked.map((member) => (
                <li
                  key={member.id}
                  className="flex flex-wrap justify-between gap-2 text-sm"
                >
                  <span className="break-all">{member.email}</span>
                  <span className="text-xs text-muted-foreground">
                    Removed · {roleLabel(member.role)}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
      <p className="max-w-3xl text-xs leading-6 text-muted-foreground">
        Staff members work with this business’s tools and data. Billing admins
        can also manage the owner’s shared subscription and purchase credits.
        Only the owner can edit business details or manage staff. Support-agent
        logins have a separate allowance.
      </p>
      <AlertDialog
        open={!!remove}
        onOpenChange={(open) => !open && !busy && setRemove(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {remove?.status === "invited"
                ? "Revoke invitation?"
                : "Remove staff access?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {remove?.email} will lose access to {businessProfileName(profile)}
              . Business data and past work are retained.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep access</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                if (remove)
                  void run(async () => {
                    await api.delete(
                      `/api/settings/business-profiles/${businessId}/members/${remove.id}`,
                      options,
                    );
                    setRemove(null);
                  }, "Staff access removed.");
              }}
            >
              Remove access
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
