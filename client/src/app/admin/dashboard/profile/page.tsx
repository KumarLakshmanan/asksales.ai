"use client";

import React, { useEffect, useState } from "react";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { useAdminAuth } from "@/contexts/AdminAuthContext";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  User,
  Mail,
  Shield,
  Save,
  ArrowLeft,
} from "lucide-react";
import { useRouter } from "next/navigation";

export default function ProfilePage() {
  const { admin, checkAuth } = useAdminAuth();
  const { toast } = useToast();
  const router = useRouter();

  const [name, setName] = useState(admin?.name || "");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setName(admin?.name || "");
  }, [admin?.name]);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      toast({
        title: "Validation Error",
        description: "Name is required",
        variant: "destructive",
      });
      return;
    }

    try {
      setIsSaving(true);
      await api.put("/api/admin/profile", { name: name.trim() });
      await checkAuth();

      toast({
        title: "Success",
        description: "Profile updated successfully",
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to update profile";
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-6 p-4 sm:p-0">
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
          <h1 className="text-2xl font-bold tracking-tight">Update Profile</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Manage your admin account information
          </p>
        </div>
      </div>

      {/* Profile Info Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-primary/10 p-2.5">
              <User className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle>Profile Information</CardTitle>
              <CardDescription>Your account details</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSaveProfile} className="space-y-5">
            {/* Avatar Section */}
            <div className="flex items-center gap-4 border-b border-border pb-4">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-primary text-xl font-bold text-primary-foreground shadow-sm">
                {name?.charAt(0)?.toUpperCase() || "A"}
              </div>
              <div>
                <p className="font-semibold text-foreground">{admin?.name || "Admin"}</p>
                <p className="break-all text-sm text-muted-foreground">{admin?.email}</p>
                <div className="flex items-center gap-1.5 mt-1">
                  <Shield className="h-3.5 w-3.5 text-primary" />
                  <span className="text-xs font-medium text-primary capitalize">
                    {admin?.role || "Admin"}
                  </span>
                </div>
              </div>
            </div>

            {/* Form Fields */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="name">Full Name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Enter your name"
                  maxLength={255}
                  autoComplete="name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email Address</Label>
                <div className="flex min-h-10 items-center gap-2 rounded-md border border-border bg-muted/50 p-2.5">
                  <Mail className="h-4 w-4 text-muted-foreground" />
                  <span className="break-all text-sm text-foreground">{admin?.email || "—"}</span>
                </div>
                <p className="text-xs text-muted-foreground">Email cannot be changed</p>
              </div>
              <div className="space-y-2">
                <Label>Role</Label>
                <div className="flex min-h-10 items-center gap-2 rounded-md border border-border bg-muted/50 p-2.5">
                  <Shield className="h-4 w-4 text-primary" />
                  <span className="text-sm font-medium capitalize text-foreground">
                    {admin?.role || "Admin"}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">Role is managed by super admin</p>
              </div>
            </div>

            {/* Action */}
            <div className="flex flex-col-reverse gap-3 border-t border-border pt-4 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" onClick={() => router.back()}>
                Cancel
              </Button>
              <Button
                type="submit"
                loading={isSaving}
                loadingText="Saving..."
              >
                <Save className="h-4 w-4" />
                Save Changes
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
