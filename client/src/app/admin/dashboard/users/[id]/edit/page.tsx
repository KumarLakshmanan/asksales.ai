"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { LoadingState } from "@/components/ui/loading-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ArrowLeft, Save, Palette, Building2 } from "lucide-react";
import { PageErrorState } from "@/components/ui/page-state";

interface BrandToolkit {
  id: number;
  name: string;
  description?: string;
  tagline?: string;
  logoUrl?: string;
  primaryBrandColor?: string;
  secondaryBrandColor?: string;
  isDefault?: boolean;
  createdAt?: string;
}

export default function EditUserPage() {
  const params = useParams();
  const id = params.id as string;
  const router = useRouter();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [brandToolkits, setBrandToolkits] = useState<BrandToolkit[]>([]);
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    role: "user",
    timezone: "",
    bio: "",
  });
  const [userMeta, setUserMeta] = useState<{
    isVerified?: boolean;
    isApproved?: boolean;
    createdAt?: string;
  }>({});

  const fetchUser = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await api.get<{ user?: Record<string, unknown>; data?: Record<string, unknown>; brandToolkits?: BrandToolkit[] } & Record<string, unknown>>(`/api/admin/users/${id}`);
      const user = (data.user || data.data || data) as Record<string, unknown>;
      setForm({
        name: (user.name as string) || "",
        email: (user.email as string) || "",
        phone: (user.phone as string) || "",
        role: (user.role as string) || "user",
        timezone: (user.timezone as string) || "",
        bio: (user.bio as string) || "",
      });
      setUserMeta({
        isVerified: user.isVerified as boolean | undefined,
        isApproved: user.isApproved as boolean | undefined,
        createdAt: ((user.createdAt || user.created_at) as string) || undefined,
      });
      // Set brand toolkits and company profile from user data
      if (data.brandToolkits) setBrandToolkits(data.brandToolkits);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to load user";
      setLoadError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.email) {
      toast({
        title: "Validation Error",
        description: "Name and Email are required.",
        variant: "destructive",
      });
      return;
    }

    try {
      setSaving(true);
      await api.put(`/api/admin/users/${id}`, form);

      toast({ title: "Success", description: "User updated successfully" });
      router.push(`/admin/dashboard/users/${id}/view`);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to update user";
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const getStatusText = () => {
    if (userMeta.isApproved && userMeta.isVerified) return "Approved";
    if (userMeta.isApproved && !userMeta.isVerified) return "Pending Verification";
    if (!userMeta.isApproved && userMeta.isVerified) return "Pending Approval";
    return "Pending";
  };

  if (loading) {
    return <LoadingState size="page" label="Loading user…" />;
  }

  if (loadError) {
    return <PageErrorState title="User could not be loaded for editing" description={loadError} reset={() => void fetchUser()} />;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex items-start gap-2 sm:items-center sm:gap-4">
        <Link href={`/admin/dashboard/users/${id}/view`} className="shrink-0">
          <Button variant="ghost" size="icon" aria-label="Back to user details">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div className="min-w-0">
          <h1 className="text-xl font-black tracking-tighter sm:text-2xl">Edit User</h1>
          <p className="text-muted-foreground mt-1">
            Update user information
          </p>
        </div>
      </div>

      {/* User Profile Summary */}
      <Card className="border-primary/20">
        <CardContent className="pt-6">
          <div className="flex items-start gap-4">
            <Avatar className="h-16 w-16 border-2 border-primary/20">
              <AvatarFallback className="bg-primary/10 text-xl font-bold text-primary">
                {(form.name || form.email || "U")
                  .split(" ")
                  .map((w) => w[0])
                  .join("")
                  .toUpperCase()
                  .slice(0, 2)}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1">
              <h2 className="text-xl font-semibold">{form.name || "—"}</h2>
              <p className="text-muted-foreground text-sm">{form.email}</p>
              <div className="flex items-center gap-2 mt-2">
                <StatusBadge
                  status={getStatusText()}
                  toneOverrides={{ pending_verification: "warning", pending_approval: "warning" }}
                />
                <Badge variant="outline" className="capitalize">{form.role}</Badge>
                {userMeta.createdAt && (
                  <span className="text-xs text-muted-foreground">
                    Joined {new Date(userMeta.createdAt).toLocaleDateString()}
                  </span>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Edit Form */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>User Details</CardTitle>
            <CardDescription>
              Modify the fields below and save your changes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Name *</Label>
                  <Input
                    id="name"
                    name="name"
                    placeholder="Full name"
                    value={form.name}
                    onChange={handleChange}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">Email *</Label>
                  <Input
                    id="email"
                    name="email"
                    type="email"
                    placeholder="user@example.com"
                    value={form.email}
                    onChange={handleChange}
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="phone">Phone</Label>
                  <Input
                    id="phone"
                    name="phone"
                    placeholder="+1 234 567 8901"
                    value={form.phone}
                    onChange={handleChange}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="role">Role</Label>
                  <Select
                    value={form.role}
                    onValueChange={(val) =>
                      setForm((prev) => ({ ...prev, role: val }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select role" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="user">User</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="timezone">Timezone</Label>
                <Input
                  id="timezone"
                  name="timezone"
                  placeholder="e.g. America/New_York"
                  value={form.timezone}
                  onChange={handleChange}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="bio">Bio</Label>
                <Textarea
                  id="bio"
                  name="bio"
                  placeholder="A short bio about the user..."
                  value={form.bio}
                  onChange={handleChange}
                  rows={4}
                />
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <Link href={`/admin/dashboard/users/${id}/view`}>
                  <Button type="button" variant="outline">
                    Cancel
                  </Button>
                </Link>
                <Button
                  type="submit"
                  className="bg-purple-600 hover:bg-purple-700"
                  loading={saving}
                  loadingText="Saving…"
                >
                  <Save />
                  Save Changes
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Right Sidebar - Brand Toolkits & Business Profile */}
        <div className="space-y-4">
          {/* Brand Toolkits Card */}
          <Link href={`/admin/dashboard/users/${id}/brand-toolkits`}>
            <Card className="hover:border-purple-300 hover:shadow-md transition-all cursor-pointer group">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-fuchsia-50 group-hover:bg-fuchsia-100 dark:bg-fuchsia-900/20 transition-colors">
                    <Palette className="h-5 w-5 text-fuchsia-500" />
                  </div>
                  <div>
                    <CardTitle className="text-base">Brand Toolkits</CardTitle>
                    <CardDescription className="text-xs">
                      {brandToolkits.length > 0
                        ? `${brandToolkits.length} toolkit${brandToolkits.length !== 1 ? "s" : ""}`
                        : "No toolkits yet"}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              {brandToolkits.length > 0 && (
                <CardContent className="pt-0">
                  <div className="space-y-2">
                    {brandToolkits.slice(0, 3).map((tk) => (
                      <div key={tk.id} className="flex items-center gap-2 text-sm">
                        {tk.primaryBrandColor && (
                          <div
                            className="w-3 h-3 rounded-full border border-gray-200"
                            style={{ backgroundColor: tk.primaryBrandColor }}
                          />
                        )}
                        <span className="truncate text-muted-foreground">{tk.name}</span>
                        {tk.isDefault && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Default</Badge>
                        )}
                      </div>
                    ))}
                    {brandToolkits.length > 3 && (
                      <p className="text-xs text-muted-foreground">+{brandToolkits.length - 3} more</p>
                    )}
                  </div>
                </CardContent>
              )}
            </Card>
          </Link>

          {/* Business Profile Card */}
          <Card className="border-blue-200/50">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-900/20">
                  <Building2 className="h-5 w-5 text-blue-500" />
                </div>
                <div>
                  <CardTitle className="text-base">Business Profile</CardTitle>
                  <CardDescription className="text-xs">
                    Company information
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <p className="text-sm text-muted-foreground">No business profile set up</p>
            </CardContent>
          </Card>

          {/* Quick Stats */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Quick Info</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Phone</span>
                <span className="font-medium">{form.phone || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Timezone</span>
                <span className="font-medium">{form.timezone || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Role</span>
                <span className="font-medium capitalize">{form.role}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
