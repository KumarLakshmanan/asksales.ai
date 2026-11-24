"use client";

import React, { useState } from "react";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import {
  Lock,
  Save,
  ArrowLeft,
  ShieldCheck,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { isStrongPassword, PASSWORD_POLICY_MESSAGE } from "@/lib/password-policy";

export default function ChangePasswordPage() {
  const { toast } = useToast();
  const router = useRouter();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!currentPassword || !newPassword || !confirmPassword) {
      toast({
        title: "Validation Error",
        description: "All password fields are required",
        variant: "destructive",
      });
      return;
    }

    if (!isStrongPassword(newPassword)) {
      toast({
        title: "Validation Error",
        description: PASSWORD_POLICY_MESSAGE,
        variant: "destructive",
      });
      return;
    }

    if (newPassword !== confirmPassword) {
      toast({
        title: "Validation Error",
        description: "New passwords do not match",
        variant: "destructive",
      });
      return;
    }

    try {
      setIsLoading(true);
      await api.post("/api/admin/change-password", { currentPassword, newPassword });

      toast({
        title: "Success",
        description: "Password changed successfully",
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to change password";
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-6 p-4 sm:p-6">
      {/* Page Header */}
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => router.back()}
          className="shrink-0"
          aria-label="Go back"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Change Password</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Update your account password
          </p>
        </div>
      </div>

      {/* Change Password Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-purple-100 p-2.5 dark:bg-purple-950/50">
              <Lock className="h-5 w-5 text-purple-700 dark:text-purple-300" />
            </div>
            <div>
              <CardTitle>Security</CardTitle>
              <CardDescription>Choose a strong password to protect your account</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleChangePassword} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="currentPassword">Current Password</Label>
              <PasswordInput
                id="currentPassword"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Enter current password"
              />
            </div>

            <div className="space-y-4 border-t border-border pt-4">
              <div className="space-y-2">
                <Label htmlFor="newPassword">New Password</Label>
                <PasswordInput
                  id="newPassword"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Enter new password"
                />
                <p className="text-xs text-muted-foreground">
                  {PASSWORD_POLICY_MESSAGE}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirmPassword">Confirm New Password</Label>
                <PasswordInput
                  id="confirmPassword"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm new password"
                />
              </div>
            </div>

            {/* Action */}
            <div className="flex flex-col-reverse gap-3 border-t border-border pt-4 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" onClick={() => {
                setCurrentPassword("");
                setNewPassword("");
                setConfirmPassword("");
              }}>
                Clear
              </Button>
              <Button
                type="submit"
                loading={isLoading}
                loadingText="Updating..."
                className="bg-purple-600 text-white hover:bg-purple-700 dark:bg-purple-500 dark:text-purple-950 dark:hover:bg-purple-400"
              >
                <Save className="h-4 w-4" />
                Update Password
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Security Tips Card */}
      <Card className="border-purple-200 bg-purple-50 dark:border-purple-900 dark:bg-purple-950/30">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-purple-700 dark:text-purple-300" />
            <CardTitle className="text-base">Password Security Tips</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm text-purple-950 dark:text-purple-100">
            <li className="flex items-start gap-2">
              <span className="mt-0.5 text-purple-700 dark:text-purple-300">•</span>
              <span>Use a unique password that you don&apos;t use for other accounts</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-0.5 text-purple-700 dark:text-purple-300">•</span>
              <span>Include a mix of uppercase and lowercase letters, numbers, and symbols</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-0.5 text-purple-700 dark:text-purple-300">•</span>
              <span>Avoid common words, phrases, or personal information</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-0.5 text-purple-700 dark:text-purple-300">•</span>
              <span>Consider using a password manager to generate and store strong passwords</span>
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
