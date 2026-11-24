"use client";

import { useEffect, useState } from "react";
import { useSupportAuth } from "@/contexts/SupportAuthContext";
import {
  User, Mail, Shield, History, ChevronRight,
  Sparkles, Users, Lock, Activity, Globe
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supportApi } from "@/lib/support-api";
import { cn } from "@/lib/utils";

interface MemberPresence {
  timezone: string;
  presenceState: "active" | "away";
  lastActivity: string | null;
  todayFirstLogin: string | null;
}

export default function SupportProfilePage() {
  const { member } = useSupportAuth();
  const router = useRouter();
  const [presence, setPresence] = useState<MemberPresence | null>(null);

  useEffect(() => {
    if (!member) return;
    let cancelled = false;
    supportApi.get<MemberPresence>("/api/support-portal/presence?days=1")
      .then((data) => { if (!cancelled) setPresence(data); })
      .catch(() => { if (!cancelled) setPresence(null); });
    return () => { cancelled = true; };
  }, [member]);

  const isOnline = presence?.presenceState === "active";
  const presenceLabel = presence ? (isOnline ? "Active now" : "Away") : "Presence unavailable";
  const firstLoginLabel = presence?.todayFirstLogin
    ? `Today, ${new Intl.DateTimeFormat("en-IN", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: presence.timezone,
      }).format(new Date(presence.todayFirstLogin))}`
    : "No activity today";

  const profileItems = [
    { label: "Full Name", value: member?.name, icon: User },
    { label: "Work Email", value: member?.email, icon: Mail },
    { label: "Access Role", value: member?.role, icon: Shield },
    { label: "Assigned Team", value: member?.teamName || "Global Support", icon: Users },
  ];

  return (
    <div className="space-y-5 max-w-screen-xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <User className="w-4 h-4 text-primary" />
        </div>
        <div>
          <h1 className="text-base font-semibold">My Profile</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Support Agent Details</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left: Avatar */}
        <div className="lg:col-span-1 space-y-3">
          <Card className="border border-border/50 rounded-xl shadow-none">
            <CardContent className="p-5 flex flex-col items-center gap-4">
              <Avatar className="w-20 h-20 rounded-xl border-2 border-border">
                <AvatarImage src={member?.avatar} className="object-cover" />
                <AvatarFallback className="bg-primary/10 text-primary text-2xl font-bold rounded-xl">
                  {member?.name?.[0].toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="text-center">
                <p className="text-sm font-semibold">{member?.name}</p>
                <p className="text-xs text-primary mt-0.5">{member?.role}</p>
              </div>
              <div className="flex items-center gap-2 flex-wrap justify-center">
                <Badge variant="outline" className="text-xs h-5 px-2 rounded-md gap-1">
                  <Activity className={cn("w-2.5 h-2.5", isOnline ? "text-success" : "text-warning")} /> {presenceLabel}
                </Badge>
                <Badge variant="outline" className="text-xs h-5 px-2 rounded-md gap-1">
                  <Globe className="w-2.5 h-2.5 text-primary" /> Support
                </Badge>
              </div>
            </CardContent>
          </Card>

          <Card className="border border-border/50 rounded-xl shadow-none">
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground p-2 rounded-lg bg-muted/30">
                <History className="w-3.5 h-3.5" />
                <div>
                  <p className="text-xs text-muted-foreground/60">Today&apos;s first login</p>
                  <p className="text-xs font-medium text-foreground">{firstLoginLabel}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-lg border border-success/10 bg-success/5 p-2 text-xs text-muted-foreground">
                <Shield className="h-3.5 w-3.5 text-success" />
                <div>
                  <p className="text-xs text-muted-foreground/60">Account status</p>
                  <p className="text-xs font-medium text-success">{member?.isActive === false ? "Disabled member" : "Active member"}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right: Details */}
        <div className="lg:col-span-2 space-y-3">
          <Card className="border border-border/50 rounded-xl shadow-none">
            <CardHeader className="px-5 pt-5 pb-4 border-b border-border/30">
              <CardTitle className="text-sm font-semibold">Account Details</CardTitle>
            </CardHeader>
            <CardContent className="p-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {profileItems.map((item, i) => (
                  <div key={i} className="space-y-1">
                    <p className="text-xs text-muted-foreground">{item.label}</p>
                    <div className="flex items-center gap-2">
                      <item.icon className="w-3.5 h-3.5 text-muted-foreground/50" />
                      <p className="text-sm font-medium">{item.value || "Not set"}</p>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-5 pt-4 border-t border-border/30 flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">Account Credentials</p>
                  <p className="text-xs text-muted-foreground/60">{member?.teamName} Team Member</p>
                </div>
                <Button variant="outline" size="sm" className="h-8 rounded-lg text-xs border-border/60 gap-1.5"
                  onClick={() => router.push("/support/settings")}>
                  Edit Settings <ChevronRight className="w-3 h-3" />
                </Button>
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button onClick={() => router.push("/support/settings")}
              className="text-left rounded-xl border border-border/50 bg-card p-4 hover:bg-muted/30 hover:border-border transition-colors">
              <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-lg bg-destructive/10">
                <Lock className="h-4 w-4 text-destructive" />
              </div>
              <p className="text-sm font-medium">Security Settings</p>
              <p className="text-xs text-muted-foreground mt-0.5">Update password and security options</p>
            </button>
            <div className="rounded-xl border border-border/50 bg-card p-4">
              <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-md border border-border bg-muted/35">
                <Sparkles className="h-4 w-4 text-primary" />
              </div>
              <p className="text-sm font-medium">Active Sessions</p>
              <p className="text-xs text-muted-foreground mt-0.5">Manage current login sessions</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
