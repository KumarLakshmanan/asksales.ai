"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ArrowLeft, KeyRound } from "lucide-react";
import { isStrongPassword, PASSWORD_POLICY_MESSAGE } from "@/lib/password-policy";
import { useAdminAuth } from "@/contexts/AdminAuthContext";

export default function UpdatePasswordPage() {
  const params = useParams();
  const id = params.id as string;
  const { toast } = useToast();
  const { admin, isLoading: authLoading } = useAdminAuth();
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    newPassword: "",
    confirmPassword: "",
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!form.newPassword || !form.confirmPassword) {
      toast({
        title: "Validation Error",
        description: "Both fields are required.",
        variant: "destructive",
      });
      return;
    }

    if (form.newPassword !== form.confirmPassword) {
      toast({
        title: "Validation Error",
        description: "Passwords do not match.",
        variant: "destructive",
      });
      return;
    }

    if (!isStrongPassword(form.newPassword)) {
      toast({
        title: "Validation Error",
        description: PASSWORD_POLICY_MESSAGE,
        variant: "destructive",
      });
      return;
    }

    try {
      setLoading(true);
      await api.put(`/api/admin/users/${id}/password`, { newPassword: form.newPassword });

      toast({
        title: "Success",
        description: "Password updated successfully",
      });
      setForm({ newPassword: "", confirmPassword: "" });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to update password";
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  if (authLoading) {
    return <LoadingState size="page" label="Checking access…" />;
  }

  if (admin?.role !== "super_admin") {
    return (
      <div className="p-4 sm:p-6">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Super-admin access required</CardTitle>
            <CardDescription>Only a super administrator can reset another user&apos;s password.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline"><Link href={`/admin/dashboard/users/${id}/view`}>Back to user details</Link></Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex items-start gap-2 sm:gap-4">
        <Button asChild variant="ghost" size="icon" className="shrink-0">
          <Link href={`/admin/dashboard/users/${id}/view`} aria-label="Back to user details">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div className="min-w-0">
          <h1 className="text-xl font-black tracking-tighter sm:text-2xl">Update Password</h1>
          <p className="text-muted-foreground mt-1">
            Set a new password for this user
          </p>
        </div>
      </div>

      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>New Password</CardTitle>
          <CardDescription>
            Enter and confirm the new password below.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="newPassword">New Password</Label>
              <PasswordInput
                id="newPassword"
                name="newPassword"
                type="password"
                placeholder="••••••••"
                value={form.newPassword}
                onChange={handleChange}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirmPassword">Confirm Password</Label>
              <PasswordInput
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                placeholder="••••••••"
                value={form.confirmPassword}
                onChange={handleChange}
                required
              />
            </div>

            <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end">
              <Button asChild type="button" variant="outline">
                <Link href={`/admin/dashboard/users/${id}/view`}>
                  Cancel
                </Link>
              </Button>
              <Button
                type="submit"
                className="bg-purple-600 text-white hover:bg-purple-700 dark:bg-purple-500 dark:text-purple-950 dark:hover:bg-purple-400"
                loading={loading}
                loadingText="Updating password…"
              >
                <KeyRound />
                Update Password
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
