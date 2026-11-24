"use client";

import { useState, useEffect, useCallback } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordVisibilityButton } from "@/components/settings/PasswordVisibilityButton";
import { WorkspaceSettingsOverview } from "@/components/settings/WorkspaceSettingsOverview";
import { WORKSPACE_SETTINGS_HREF } from "@/lib/settings-navigation";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { useAuth } from "@/contexts/AuthContext";
import {
  Bell, User, Save, Shield, Globe, Clock,
  Smartphone, Mail, Activity, Zap, Target, Sparkles, Key, ShieldCheck,
  Fingerprint, Settings2, AlertTriangle, RotateCcw, ArrowRight, Headphones
} from "lucide-react";
import api from "@/lib/api";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { AnimatePresence, motion } from "framer-motion";
import { Separator } from "@/components/ui/separator";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { LoadingState } from "@/components/ui/loading-state";

const VALID_TABS = ["profile", "security", "notifications", "support"] as const;
type TabId = typeof VALID_TABS[number];

const tabs = [
  { id: "profile" as TabId, label: "Profile", icon: User },
  { id: "security" as TabId, label: "Security", icon: Shield },
  { id: "notifications" as TabId, label: "Notifications", icon: Bell },
  { id: "support" as TabId, label: "Workspace support", icon: Headphones },
];

export default function SettingsPage() {
  const { toast } = useToast();
  const { logout, user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const getTabFromUrl = useCallback((): TabId => {
    const tab = searchParams.get("tab");
    return VALID_TABS.includes(tab as TabId) ? (tab as TabId) : "profile";
  }, [searchParams]);

  const [activeTab, setActiveTab] = useState<TabId>(getTabFromUrl);

  useEffect(() => { setActiveTab(getTabFromUrl()); }, [getTabFromUrl]);

  const handleTabChange = (tabId: TabId) => {
    setActiveTab(tabId);
    router.push(`${pathname}?tab=${tabId}`, { scroll: false });
  };

  const [isSaving, setIsSaving] = useState(false);
  const [profileLoading, setProfileLoading] = useState(true);
  const [notificationLoading, setNotificationLoading] = useState(true);
  const [profileError, setProfileError] = useState(false);
  const [notificationError, setNotificationError] = useState(false);
  const [profileData, setProfileData] = useState({ name: "", email: "", avatar: "", bio: "", phone: "" });
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; phone?: string }>({});
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [passwordData, setPasswordData] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [notifications, setNotifications] = useState({ leadAlerts: true, campaignUpdates: true });
  const [savedNotifications, setSavedNotifications] = useState({ leadAlerts: true, campaignUpdates: true });
  const notificationChanges: Partial<typeof notifications> = {};
  for (const key of ["leadAlerts", "campaignUpdates"] as const) {
    if (notifications[key] !== savedNotifications[key]) notificationChanges[key] = notifications[key];
  }
  const hasNotificationChanges = Object.keys(notificationChanges).length > 0;
  useUnsavedChanges(hasNotificationChanges, "You have unsaved notification preferences. Leave without saving?");

  type ProfileData = { [K in keyof typeof profileData]: string | null };

  const fetchUserProfile = useCallback(async () => {
    try {
      setProfileLoading(true);
      setProfileError(false);
      const data = await api.get<ProfileData>("/api/settings/profile");
      setProfileData({
        name: data.name ?? "",
        email: data.email ?? "",
        avatar: data.avatar ?? "",
        bio: data.bio ?? "",
        phone: data.phone ?? "",
      });
    } catch {
      setProfileError(true);
      toast({ title: "Failed to load profile", description: "Please refresh the page.", variant: "destructive" });
    } finally { setProfileLoading(false); }
  }, [toast]);

  useEffect(() => { fetchUserProfile(); }, [fetchUserProfile]);

  const fetchNotificationPreferences = useCallback(async () => {
    try {
      setNotificationLoading(true);
      setNotificationError(false);
      const data = await api.get<typeof notifications>("/api/settings/profile/notification-preferences");
      const selected = { leadAlerts: data.leadAlerts, campaignUpdates: data.campaignUpdates };
      setNotifications(selected);
      setSavedNotifications(selected);
    } catch {
      setNotificationError(true);
    } finally { setNotificationLoading(false); }
  }, []);

  useEffect(() => { fetchNotificationPreferences(); }, [fetchNotificationPreferences]);

  const handleProfileChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setProfileData((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPasswordData((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleNotificationChange = (key: keyof typeof notifications, value: boolean) => {
    setNotifications((prev) => ({ ...prev, [key]: value }));
  };

  const handleSaveNotifications = async () => {
    if (isSaving || notificationError || !hasNotificationChanges) return;
    setIsSaving(true);
    try {
      const saved = await api.put<typeof notifications>("/api/settings/profile/notification-preferences", notificationChanges);
      const selected = { leadAlerts: saved.leadAlerts, campaignUpdates: saved.campaignUpdates };
      setNotifications(selected);
      setSavedNotifications(selected);
      toast({ title: "Notification preferences saved." });
    } catch {
      toast({ title: "Error", description: "Failed to save preferences", variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    const errors: { name?: string; phone?: string } = {};
    if (!profileData.name?.trim()) errors.name = "Name is required.";
    if (profileData.phone && !/^\+?[\d\s\-().]{7,20}$/.test(profileData.phone)) errors.phone = "Please enter a valid phone number.";
    if (Object.keys(errors).length > 0) { setFieldErrors(errors); return; }
    setFieldErrors({});
    setIsSaving(true);
    try {
      await api.put("/api/settings/profile", profileData);
      toast({ title: "Profile Updated", description: "Your changes have been saved." });
    } catch {
      toast({ title: "Error", description: "Failed to update profile", variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  };

  const handleChangePassword = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!passwordData.currentPassword || !passwordData.newPassword || !passwordData.confirmPassword) {
      toast({ title: "All password fields are required", variant: "destructive" });
      return;
    }
    if (passwordData.newPassword !== passwordData.confirmPassword) {
      toast({ title: "Error", description: "Passwords do not match", variant: "destructive" });
      return;
    }
    if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,128}$/.test(passwordData.newPassword)) {
      toast({ title: "Password is not strong enough", description: "Use 8–128 characters with uppercase, lowercase, number, and special character.", variant: "destructive" });
      return;
    }
    setIsSaving(true);
    try {
      await api.post("/api/settings/profile/change-password", { currentPassword: passwordData.currentPassword, newPassword: passwordData.newPassword });
      toast({ title: "Password Changed", description: "Sign in again with your new password." });
      setPasswordData({ currentPassword: "", newPassword: "", confirmPassword: "" });
      await logout();
      router.replace("/login");
    } catch (error: unknown) {
      toast({ title: "Error", description: error instanceof Error ? error.message : "Failed to update password", variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-6 px-4 py-5 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <PageHeader
          icon={Settings2}
          title="Account settings"
          subtitle="Your profile, security and personal notifications apply to your account across workspaces."
          actions={<Button asChild variant="outline"><Link href={WORKSPACE_SETTINGS_HREF}>Workspace configuration <ArrowRight className="ml-1.5 h-4 w-4" /></Link></Button>}
        />

        <div className="flex flex-wrap items-center gap-1 bg-muted/40 p-1 rounded-lg border border-border/40">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                className={cn(
                  "relative flex items-center gap-1.5 h-8 px-3 text-xs font-medium transition-all rounded-md",
                  isActive ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {isActive && (
                  <motion.div layoutId="activeTabBg" className="absolute inset-0 bg-primary rounded-md z-0" />
                )}
                <Icon className="w-3.5 h-3.5 relative z-10" />
                <span className="relative z-10">{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <Separator className="bg-border/50" />
      <p className="break-words text-xs text-muted-foreground">Account: {user?.email || "Signed-in account"}</p>

      <AnimatePresence mode="wait">
        <motion.div key={activeTab} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }} transition={{ duration: 0.2 }} className="space-y-5">
          {/* Profile Tab */}
          {activeTab === "profile" && (
            profileLoading ? (
              <LoadingState size="section" className="min-h-[320px]" label="Loading your profile…" />
            ) : profileError ? (
              <div className="flex flex-col items-center justify-center py-16 gap-4">
                <AlertTriangle className="w-10 h-10 text-destructive/60" />
                <p className="text-sm text-muted-foreground">Failed to load your profile. Please try again.</p>
                <Button variant="outline" size="sm" onClick={fetchUserProfile}>Retry</Button>
              </div>
            ) : (
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
              <div className="xl:col-span-2 space-y-5">
                <form onSubmit={handleSaveProfile} className="space-y-5">
                  <Card className="rounded-xl border border-border/50 shadow-none">
                    <CardHeader className="px-5 pt-5 pb-4">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-muted/40 text-muted-foreground">
                          <User className="w-4 h-4" />
                        </div>
                        <div>
                          <CardTitle className="text-sm font-semibold">Profile</CardTitle>
                          <CardDescription className="text-xs mt-0.5">Update your personal information.</CardDescription>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="px-5 pb-5 space-y-4">
                      <div className="flex items-center gap-4 p-3 rounded-lg bg-muted/20 border border-border/20">
                        <div>
                          <div className="w-12 h-12 rounded-full bg-zinc-900 border-2 border-white dark:border-zinc-800 flex items-center justify-center text-white text-sm font-semibold overflow-hidden">
                            {profileData.avatar ? (
                              <img src={profileData.avatar} alt="Avatar" className="w-full h-full object-cover" />
                            ) : (
                              profileData.name?.charAt(0)?.toUpperCase() || "U"
                            )}
                          </div>
                        </div>
                        <div>
                          <p className="text-sm font-semibold">{profileData.name || "User Name"}</p>
                          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                            <Mail className="w-3 h-3" /> {profileData.email}
                          </p>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                          <Label htmlFor="name" className="text-xs font-medium text-muted-foreground">Full Name</Label>
                          <div className="relative">
                            <User className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/50" />
                            <Input id="name" name="name" value={profileData.name} onChange={(e) => { handleProfileChange(e); if (fieldErrors.name) setFieldErrors(f => ({...f, name: undefined})); }} required placeholder="Enter full name" className={`h-9 pl-9 rounded-lg text-sm ${fieldErrors.name ? 'border-destructive' : 'border-border/60'}`} />
                          </div>
                          {fieldErrors.name && <p className="text-xs text-destructive">{fieldErrors.name}</p>}
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="email" className="text-xs font-medium text-muted-foreground">Email Address</Label>
                          <div className="relative opacity-60">
                            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/50" />
                            <Input id="email" name="email" value={profileData.email} disabled className="h-9 pl-9 rounded-lg border-border/60 text-sm cursor-not-allowed" />
                          </div>
                          <p className="text-xs text-muted-foreground">Read-only</p>
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="phone" className="text-xs font-medium text-muted-foreground">Phone</Label>
                          <div className="relative">
                            <Smartphone className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/50" />
                            <Input id="phone" name="phone" value={profileData.phone} onChange={(e) => { handleProfileChange(e); if (fieldErrors.phone) setFieldErrors(f => ({...f, phone: undefined})); }} placeholder="+1 (XXX) XXX-XXXX" className={`h-9 pl-9 rounded-lg text-sm ${fieldErrors.phone ? 'border-destructive' : 'border-border/60'}`} />
                          </div>
                          {fieldErrors.phone && <p className="text-xs text-destructive">{fieldErrors.phone}</p>}
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="bio" className="text-xs font-medium text-muted-foreground">Biography</Label>
                        <Textarea id="bio" name="bio" value={profileData.bio} onChange={handleProfileChange} rows={3} placeholder="Tell us about yourself..." className="rounded-lg border-border/60 text-sm resize-none" />
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="avatar" className="text-xs font-medium text-muted-foreground">Profile Picture URL</Label>
                        <div className="relative">
                          <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/50" />
                          <Input id="avatar" name="avatar" value={profileData.avatar} onChange={handleProfileChange} placeholder="https://example.com/profile.jpg" className="h-9 pl-9 rounded-lg border-border/60 text-sm" />
                        </div>
                      </div>
                    </CardContent>
                    <CardFooter className="px-5 pb-5 flex justify-end gap-2">
                      <Button type="button" variant="ghost" size="sm" className="h-8 rounded-lg text-xs" onClick={fetchUserProfile}>Reset</Button>
                      <Button type="submit" size="sm" loading={isSaving} loadingText="Saving…" className="h-8 rounded-lg text-xs px-4 gap-1.5">
                        <Save className="w-3.5 h-3.5" />
                        Save Profile
                      </Button>
                    </CardFooter>
                  </Card>
                </form>
              </div>

              <div className="space-y-4">
                <Card className="overflow-hidden rounded-xl border border-border shadow-none">
                  <CardContent className="p-5 space-y-4">
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-muted/40 text-muted-foreground">
                      <Sparkles className="w-4 h-4" />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold">Profile Status</h3>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {[profileData.name, profileData.email, profileData.phone, profileData.bio].filter(Boolean).length} of 4 profile details completed.
                      </p>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full bg-primary transition-[width]"
                        style={{ width: `${([profileData.name, profileData.email, profileData.phone, profileData.bio].filter(Boolean).length / 4) * 100}%` }}
                      />
                    </div>
                  </CardContent>
                </Card>

                <Card className="rounded-xl border border-border/50 shadow-none">
                  <CardContent className="p-5 space-y-3">
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4 text-muted-foreground" />
                      <h4 className="text-sm font-semibold">Language &amp; Region</h4>
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">Timezone, locale, currency, and color theme are managed as account-wide preferences.</p>
                    <Button variant="outline" size="sm" className="h-8 w-full justify-between text-xs" onClick={() => router.push("/dashboard/settings/preferences")}>
                      Open preferences <ArrowRight className="h-3.5 w-3.5" />
                    </Button>
                  </CardContent>
                </Card>
              </div>
            </div>
            )
          )}

          {/* Security Tab */}
          {activeTab === "security" && (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
              <div className="space-y-5">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-500">
                    <ShieldCheck className="w-4 h-4" />
                  </div>
                  <div>
                    <h2 className="text-sm font-semibold">Security Settings</h2>
                    <p className="text-xs text-muted-foreground">Manage your password and security</p>
                  </div>
                </div>

                <Card className="rounded-xl border border-border/50 shadow-none">
                  <CardHeader className="px-5 pt-5 pb-3">
                    <CardTitle className="text-sm font-semibold">Update Password</CardTitle>
                    <CardDescription className="text-xs">Update your account access password.</CardDescription>
                  </CardHeader>
                  <CardContent className="px-5 pb-5">
                    <form onSubmit={(e) => e.preventDefault()} className="space-y-4">
                      <div className="space-y-1.5">
                        <Label htmlFor="currentPassword" className="text-xs font-medium text-muted-foreground">Current Password</Label>
                        <div className="relative">
                          <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/50" />
                          <Input id="currentPassword" name="currentPassword" type={showCurrentPassword ? "text" : "password"} value={passwordData.currentPassword} onChange={handlePasswordChange} required placeholder="Current password" className="h-9 pl-9 pr-11 rounded-lg border-border/60 text-sm" />
                          <PasswordVisibilityButton
                            inputId="currentPassword"
                            visible={showCurrentPassword}
                            onToggle={() => setShowCurrentPassword(visible => !visible)}
                            showLabel="Show current password"
                            hideLabel="Hide current password"
                          />
                        </div>
                      </div>
                      <Separator className="opacity-40" />
                      <div className="space-y-1.5">
                        <Label htmlFor="newPassword" className="text-xs font-medium text-muted-foreground">New Password</Label>
                        <div className="relative">
                          <Zap className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/50" />
                          <Input id="newPassword" name="newPassword" type={showNewPassword ? "text" : "password"} value={passwordData.newPassword} onChange={handlePasswordChange} required placeholder="New password (min 8 chars)" className="h-9 pl-9 pr-11 rounded-lg border-border/60 text-sm" />
                          <PasswordVisibilityButton
                            inputId="newPassword"
                            visible={showNewPassword}
                            onToggle={() => setShowNewPassword(visible => !visible)}
                            showLabel="Show new password"
                            hideLabel="Hide new password"
                          />
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="confirmPassword" className="text-xs font-medium text-muted-foreground">Confirm New Password</Label>
                        <div className="relative">
                          <Fingerprint className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/50" />
                          <Input id="confirmPassword" name="confirmPassword" type={showConfirmPassword ? "text" : "password"} value={passwordData.confirmPassword} onChange={handlePasswordChange} required placeholder="Confirm new password" className="h-9 pl-9 pr-11 rounded-lg border-border/60 text-sm" />
                          <PasswordVisibilityButton
                            inputId="confirmPassword"
                            visible={showConfirmPassword}
                            onToggle={() => setShowConfirmPassword(visible => !visible)}
                            showLabel="Show confirm password"
                            hideLabel="Hide confirm password"
                          />
                        </div>
                      </div>
                      <div className="flex gap-2 pt-1">
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button type="button" size="sm" loading={isSaving} loadingText="Updating…" className="h-8 rounded-lg text-xs px-4 gap-1.5 bg-emerald-600 hover:bg-emerald-700">
                              <ShieldCheck className="w-3.5 h-3.5" />
                              Update Password
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Change Password?</AlertDialogTitle>
                              <AlertDialogDescription>This updates your password immediately and signs out existing sessions.</AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction onClick={() => handleChangePassword({ preventDefault: () => {} } as React.FormEvent)} className="bg-emerald-600 hover:bg-emerald-700">Confirm Change</AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                        <Button type="button" variant="ghost" size="sm" className="h-8 rounded-lg text-xs" onClick={() => setPasswordData({ currentPassword: "", newPassword: "", confirmPassword: "" })}>Reset</Button>
                      </div>
                    </form>
                  </CardContent>
                </Card>
              </div>

              <div className="space-y-5">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-500">
                    <Activity className="w-4 h-4" />
                  </div>
                  <div>
                    <h2 className="text-sm font-semibold">Security Tips</h2>
                    <p className="text-xs text-muted-foreground">Security best practices</p>
                  </div>
                </div>

                <Card className="rounded-xl border border-border/50 shadow-none">
                  <CardContent className="p-5 space-y-3">
                    {[
                      { title: "Unique Password", desc: "Never reuse passwords across platforms.", icon: Target },
                      { title: "Complex Characters", desc: "Mix letters, numbers, and symbols.", icon: Zap },
                      { title: "Regular Updates", desc: "Update your password regularly.", icon: RotateCcw },
                      { title: "Private Device", desc: "Sign out when using shared computers.", icon: Fingerprint },
                    ].map((tip, i) => (
                      <div key={i} className="flex gap-3 items-start py-2 border-b border-border/20 last:border-0">
                        <div className="w-7 h-7 rounded-md bg-muted/60 flex items-center justify-center shrink-0">
                          <tip.icon className="w-3.5 h-3.5 text-muted-foreground" />
                        </div>
                        <div>
                          <p className="text-xs font-medium">{tip.title}</p>
                          <p className="text-xs text-muted-foreground">{tip.desc}</p>
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </div>
            </div>
          )}

          {/* Notifications Tab */}
          {activeTab === "notifications" && (
            <div className="max-w-2xl space-y-5">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-indigo-500/10 flex items-center justify-center text-indigo-500">
                  <Bell className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold">Notifications</h2>
                  <p className="text-xs text-muted-foreground">Control which notifications you receive.</p>
                </div>
              </div>

              {notificationLoading ? (
                <LoadingState size="section" className="min-h-[240px] rounded-xl border border-border bg-card" label="Loading notification settings…" />
              ) : notificationError ? (
                <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-border bg-card px-5 py-12 text-center">
                  <AlertTriangle className="h-8 w-8 text-destructive/70" />
                  <p className="text-sm font-medium">Notification preferences could not be loaded.</p>
                  <Button variant="outline" size="sm" onClick={fetchNotificationPreferences}>Retry</Button>
                </div>
              ) : <Card className="rounded-xl border border-border/50 shadow-none">
                <CardContent className="p-5 space-y-3">
                  {[
                    { id: "leadAlerts", title: "Lead Alerts", desc: "In-app alerts for lead assignments and high-value lead activity.", icon: Target },
                    { id: "campaignUpdates", title: "Campaign Status", desc: "In-app updates for campaign and outreach status changes.", icon: Activity },
                  ].map((pref) => (
                    <div key={pref.id} className="flex items-center justify-between py-3 border-b border-border/20 last:border-0">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center text-indigo-500">
                          <pref.icon className="w-4 h-4" />
                        </div>
                        <div>
                          <p className="text-sm font-medium">{pref.title}</p>
                          <p className="text-xs text-muted-foreground">{pref.desc}</p>
                        </div>
                      </div>
                      <Switch
                        disabled={isSaving}
                        checked={notifications[pref.id as keyof typeof notifications]}
                        onCheckedChange={(checked) => handleNotificationChange(pref.id as keyof typeof notifications, checked)}
                        aria-label={pref.title}
                        className="data-[state=checked]:bg-indigo-600"
                      />
                    </div>
                  ))}
                </CardContent>
              </Card>}

              <div className="flex items-center justify-between gap-4 p-3 rounded-lg bg-muted/20 border border-border/20">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
                  <p className="text-xs text-muted-foreground">You might miss updates if you disable notifications.</p>
                </div>
                <Button size="sm" loading={isSaving} disabled={notificationError || !hasNotificationChanges} onClick={handleSaveNotifications} className="h-8 rounded-lg text-xs px-4 shrink-0">
                  Save
                </Button>
              </div>
            </div>
          )}

          {activeTab === "support" && (
            <div className="space-y-5">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-500/10 text-violet-500">
                  <Headphones className="h-4 w-4" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold">Workspace support</h2>
                  <p className="text-xs text-muted-foreground">Support assignment alerts affect the selected workspace and all its support teams.</p>
                </div>
              </div>
              <WorkspaceSettingsOverview destinationIds={["support-notifications"]} />
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
