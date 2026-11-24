"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { LoadingState } from "@/components/ui/loading-state";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ArrowLeft, Shield } from "lucide-react";
import { isStrongPassword, PASSWORD_POLICY_MESSAGE } from "@/lib/password-policy";
import { useAdminAuth } from "@/contexts/AdminAuthContext";

export default function NewAdminPage() {
  const router = useRouter();
  const { toast } = useToast();
  const { admin, isLoading: authLoading } = useAdminAuth();
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!form.name || !form.email || !form.password) {
      toast({
        title: "Validation Error",
        description: "All fields are required",
        variant: "destructive",
      });
      return;
    }

    if (!isStrongPassword(form.password)) {
      toast({ title: "Invalid password", description: PASSWORD_POLICY_MESSAGE, variant: "destructive" });
      return;
    }

    try {
      setLoading(true);
      await api.post("/api/admin/admins", form);

      toast({ title: "Success", description: "Admin created successfully" });
      router.push("/admin/dashboard/admins");
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to create admin";
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
        <Card className="max-w-lg">
          <CardHeader>
            <CardTitle>Super-admin access required</CardTitle>
            <CardDescription>Only a super administrator can create administrator accounts.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline"><Link href="/admin/dashboard/admins">Back to administrators</Link></Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex items-start gap-2 sm:gap-4">
        <Button asChild variant="ghost" size="icon" className="shrink-0">
          <Link href="/admin/dashboard/admins" aria-label="Back to administrators">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-black tracking-tighter sm:text-2xl">
            <Shield className="h-7 w-7 shrink-0 text-purple-600 dark:text-purple-400 sm:h-8 sm:w-8" />
            Create Admin
          </h1>
          <p className="text-muted-foreground mt-1">
            Add a new administrator account
          </p>
        </div>
      </div>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Admin Details</CardTitle>
          <CardDescription>
            Enter the details for the new admin account
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                placeholder="Enter admin name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="Enter email address"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <PasswordInput
                id="password"
                placeholder="Enter password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                required
              />
            </div>

            <div className="flex flex-col-reverse gap-3 pt-4 sm:flex-row">
              <Button
                type="submit"
                className="bg-purple-600 text-white hover:bg-purple-700 dark:bg-purple-500 dark:text-purple-950 dark:hover:bg-purple-400"
                loading={loading}
                loadingText="Creating admin…"
              >
                Create Admin
              </Button>
              <Button asChild type="button" variant="outline">
                <Link href="/admin/dashboard/admins">
                  Cancel
                </Link>
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
