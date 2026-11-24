"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadingState } from "@/components/ui/loading-state";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  ArrowLeft,
  MessageSquare,
  Megaphone,
  Users,
  Mail,
  Instagram,
  MessageCircle,
  Phone,
  FileText,
  Layout,
  Palette,
  BarChart3,
  Activity,
  Pencil,
  KeyRound,
  Wallet,
  BookOpen,
  SlidersHorizontal,
  Lock,
  Target,
} from "lucide-react";
import { useAdminAuth } from "@/contexts/AdminAuthContext";
import { PageErrorState } from "@/components/ui/page-state";

interface UserDetail {
  id: number;
  name: string;
  email: string;
  role: string;
  phone?: string;
  timezone?: string;
  bio?: string;
  status?: string;
  isVerified?: boolean;
  isApproved?: boolean;
  createdAt?: string;
  created_at?: string;
}

const navCards: { label: string; icon: React.ElementType; path: string; color: string; superAdminOnly?: boolean }[] = [
  { label: "Module Access", icon: SlidersHorizontal, path: "modules", color: "text-amber-600", superAdminOnly: true },
  { label: "Chats", icon: MessageSquare, path: "chats", color: "text-blue-500" },
  { label: "Campaigns", icon: Megaphone, path: "campaigns", color: "text-orange-500" },
  { label: "Leads", icon: Users, path: "leads", color: "text-green-500" },
  { label: "Ideal Customer Profiles", icon: Target, path: "icps", color: "text-emerald-600" },
  { label: "Email Outreach", icon: Mail, path: "outreach/email", color: "text-blue-600" },
  { label: "Instagram", icon: Instagram, path: "outreach/instagram", color: "text-pink-500" },
  { label: "SMS", icon: Phone, path: "outreach/sms", color: "text-emerald-500" },
  { label: "WhatsApp", icon: MessageCircle, path: "outreach/whatsapp", color: "text-green-600" },
  { label: "Content", icon: FileText, path: "content", color: "text-violet-500" },
  { label: "Templates", icon: Layout, path: "templates", color: "text-indigo-500" },
  { label: "Brand Toolkits", icon: Palette, path: "brand-toolkits", color: "text-fuchsia-500" },
  { label: "Knowledge Base", icon: BookOpen, path: "knowledge-base", color: "text-cyan-500" },
  { label: "Ads", icon: BarChart3, path: "ads", color: "text-amber-500" },
  { label: "Usage", icon: Activity, path: "usage", color: "text-cyan-500" },
  { label: "Billing", icon: Wallet, path: "billing", color: "text-purple-500" },
];

export default function UserViewPage() {
  const params = useParams();
  const id = params.id as string;
  const { toast } = useToast();
  const { admin: currentAdmin } = useAdminAuth();
  const [user, setUser] = useState<UserDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchUser = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await api.get<{ user?: UserDetail; data?: UserDetail } | UserDetail>(`/api/admin/users/${id}`);
      const userData = ('user' in data ? data.user : undefined) || ('data' in data ? data.data : undefined) || data;
      setUser(userData as UserDetail);
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

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return "—";
    return new Date(dateStr).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  };

  const getAccountStatus = (u: UserDetail) => {
    let status: string;
    if (u.status) {
      status = u.status;
    } else if (u.isApproved && u.isVerified) {
      status = "approved";
    } else if (u.isApproved && !u.isVerified) {
      status = "pending verification";
    } else if (!u.isApproved && u.isVerified) {
      status = "pending approval";
    } else {
      status = "pending";
    }
    return status;
  };

  if (loading) {
    return <LoadingState size="page" label="Loading user details…" />;
  }

  if (loadError) {
    return <PageErrorState title="User details could not be loaded" description={loadError} reset={() => void fetchUser()} />;
  }

  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <p className="text-muted-foreground">User not found</p>
        <Link href="/admin/dashboard/users">
          <Button variant="outline">Back to Users</Button>
        </Link>
      </div>
    );
  }

  const accountStatus = getAccountStatus(user);

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-start gap-2 sm:gap-4">
        <Button asChild variant="ghost" size="icon" className="shrink-0">
          <Link href="/admin/dashboard/users" aria-label="Back to users">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-black tracking-tighter">User Details</h1>
          <p className="text-muted-foreground mt-1">
            Viewing profile for {user.name || user.email}
          </p>
        </div>
        <div className="flex w-full flex-wrap justify-end gap-2 sm:w-auto">
          <Button asChild variant="outline" size="sm">
            <Link href={`/admin/dashboard/users/${id}/edit`}>
              <Pencil className="h-4 w-4 mr-2" />
              Edit
            </Link>
          </Button>
          {currentAdmin?.role === "super_admin" ? (
            <Button asChild variant="outline" size="sm">
              <Link href={`/admin/dashboard/users/${id}/update-password`}>
                <KeyRound className="h-4 w-4 mr-2" />
                Update Password
              </Link>
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled title="Only super admins can change a user password.">
              <Lock className="mr-2 h-4 w-4" />
              Update Password · Super admin
            </Button>
          )}
        </div>
      </div>

      {/* Profile Card */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col sm:flex-row items-start gap-6">
            <Avatar className="h-20 w-20 border-2 border-primary/20">
              <AvatarFallback className="bg-primary/10 text-2xl font-bold text-primary">
                {(user.name || user.email || "U")
                  .split(" ")
                  .map((w) => w[0])
                  .join("")
                  .toUpperCase()
                  .slice(0, 2)}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 space-y-3">
              <div>
                <h2 className="text-2xl font-semibold">{user.name || "—"}</h2>
                <p className="text-muted-foreground">{user.email}</p>
              </div>
              <div className="flex flex-wrap gap-3">
                <StatusBadge
                  status={accountStatus}
                  tone={accountStatus.toLowerCase().includes("pending") ? "warning" : undefined}
                  toneOverrides={{ banned: "danger" }}
                />
                <Badge variant="outline" className="capitalize">
                  {user.role || "user"}
                </Badge>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2 text-sm">
                <div>
                  <span className="text-muted-foreground">Phone:</span>{" "}
                  <span className="font-medium">{user.phone || "—"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Timezone:</span>{" "}
                  <span className="font-medium">{user.timezone || "—"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Joined:</span>{" "}
                  <span className="font-medium">
                    {formatDate(user.createdAt || user.created_at)}
                  </span>
                </div>
              </div>
              {user.bio && (
                <p className="text-sm text-muted-foreground pt-1">{user.bio}</p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Navigation Cards */}
      <div>
        <h3 className="text-lg font-semibold mb-4">User Data</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {navCards.map((card) => {
            const Icon = card.icon;
            const locked = Boolean(card.superAdminOnly && currentAdmin?.role !== "super_admin");
            const cardContent = (
              <>
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-3">
                    <div className="rounded-lg bg-muted p-2 transition-colors group-hover:bg-purple-50 dark:group-hover:bg-purple-900/20">
                      <Icon className={`h-5 w-5 ${card.color}`} />
                    </div>
                    <CardTitle className="text-base">{card.label}</CardTitle>
                    {locked && <Lock className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />}
                  </div>
                </CardHeader>
                <CardContent>
                  <CardDescription>
                    {locked
                      ? "Only super admins can change account-level module access."
                      : `View user’s ${card.label.toLowerCase()}`}
                  </CardDescription>
                </CardContent>
              </>
            );
            return locked ? (
              <Card key={card.path} aria-disabled="true" title="Only super admins can change account-level module access." className="cursor-not-allowed opacity-75">
                {cardContent}
              </Card>
            ) : (
              <Link key={card.path} href={`/admin/dashboard/users/${id}/${card.path}`} className="group block">
                <Card className="transition-all hover:border-purple-300 hover:shadow-md">
                  {cardContent}
                </Card>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
