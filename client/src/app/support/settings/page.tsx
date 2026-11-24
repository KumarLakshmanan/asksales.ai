"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Settings, Lock, ShieldCheck, User, Mail, Layout, AlertCircle, BellRing
} from "lucide-react";
import { useSupportAuth } from "@/contexts/SupportAuthContext";
import { supportApi } from "@/lib/support-api";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { isStrongPassword, PASSWORD_POLICY_MESSAGE } from "@/lib/password-policy";

export default function SupportSettings() {
  const router = useRouter();
  const { toast } = useToast();
  const { member, isAuthenticated, isLoading: authLoading } = useSupportAuth();

  const [passwords, setPasswords] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [changingPassword, setChangingPassword] = useState(false);
  const [availability,setAvailability]=useState({isOnCall:false,locale:"en-IN",timezone:"Asia/Kolkata",quietHours:{enabled:false,start:"22:00",end:"08:00"}});

  useEffect(() => {
    if (!authLoading && !isAuthenticated) router.push("/support/login");
  }, [authLoading, isAuthenticated, router]);

  useEffect(() => {
    if (!isAuthenticated) return;
    void supportApi.get<typeof availability>("/api/support-portal/notification-availability").then(setAvailability).catch(()=>undefined);
  }, [isAuthenticated, toast]);
  const saveAvailability=async()=>{try{const updated=await supportApi.put<typeof availability>("/api/support-portal/notification-availability",availability);setAvailability(updated);toast({title:"Availability settings saved"});}
    catch(error){toast({title:"Unable to save availability",description:error instanceof Error?error.message:"Please try again.",variant:"destructive"});}};


  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (passwords.newPassword !== passwords.confirmPassword) {
      toast({ title: "Error", description: "Passwords do not match", variant: "destructive" });
      return;
    }
    if (!isStrongPassword(passwords.newPassword)) {
      toast({ title: "Weak password", description: PASSWORD_POLICY_MESSAGE, variant: "destructive" });
      return;
    }
    setChangingPassword(true);
    try {
      await supportApi.put("/api/support-portal/change-password", {
        currentPassword: passwords.currentPassword,
        newPassword: passwords.newPassword,
      });
      toast({ title: "Success", description: "Password changed successfully" });
      setPasswords({ currentPassword: "", newPassword: "", confirmPassword: "" });
    } catch (error) {
      toast({ title: "Error", description: error instanceof Error ? error.message : "Failed to change password", variant: "destructive" });
    } finally {
      setChangingPassword(false);
    }
  };

  if (authLoading) return <LoadingState label="Loading settings…" />;
  if (!isAuthenticated) return null;

  return (
    <div className="space-y-5 max-w-screen-xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <Settings className="w-4 h-4 text-primary" />
        </div>
        <div>
          <h1 className="text-base font-semibold">Settings</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Agent notifications, profile, and security settings</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Left: Member Info */}
        <div className="space-y-3">
          <Card className="border border-border/50 rounded-xl shadow-none">
            <CardContent className="p-4">
              <div className="flex flex-col items-center gap-3 text-center mb-4">
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
                  <User className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-semibold">{member?.name}</p>
                  <p className="text-xs text-primary">{member?.role}</p>
                </div>
              </div>
              <div className="space-y-2 pt-3 border-t border-border/30">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Mail className="w-3.5 h-3.5" />
                  <span className="truncate">{member?.email}</span>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Layout className="w-3.5 h-3.5" />
                  <span className="truncate">{member?.teamName} Team</span>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border border-border/50 rounded-xl shadow-none">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <ShieldCheck className="w-3.5 h-3.5 text-primary" />
                <p className="text-xs font-semibold">Security Overview</p>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Encryption</span>
                  <span className="font-medium text-success">AES-256</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Link Safety</span>
                  <span className="font-medium text-primary">Verified</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right: Password Form */}
        <div className="md:col-span-2 space-y-3">
          <Card className="border border-border/50 rounded-xl shadow-none">
            <CardHeader className="px-5 pt-5 pb-4 border-b border-border/30">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <BellRing className="h-4 w-4 text-primary" /> Ticket and handoff notifications
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                Email and WhatsApp assignment alerts are controlled globally by the workspace owner. Your saved member contact is used automatically when a ticket is assigned to you.
              </p>
            </CardHeader>
            <CardContent className="p-5">
              <div className="mb-4 grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-4">
                <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={availability.isOnCall} onChange={(e)=>setAvailability((v)=>({...v,isOnCall:e.target.checked}))}/>Available on call</label>
                <div><Label htmlFor="support-timezone" className="text-[11px]">Timezone</Label><Input id="support-timezone" className="mt-1 h-8 text-xs" value={availability.timezone} onChange={(e)=>setAvailability((v)=>({...v,timezone:e.target.value}))}/></div>
                <div><Label htmlFor="quiet-hours-start" className="text-[11px]">Quiet hours start</Label><Input id="quiet-hours-start" type="time" className="mt-1 h-8 text-xs" value={availability.quietHours.start} onChange={(e)=>setAvailability((v)=>({...v,quietHours:{...v.quietHours,start:e.target.value}}))}/></div>
                <div><Label htmlFor="quiet-hours-end" className="text-[11px]">Quiet hours end</Label><Input id="quiet-hours-end" type="time" className="mt-1 h-8 text-xs" value={availability.quietHours.end} onChange={(e)=>setAvailability((v)=>({...v,quietHours:{...v.quietHours,end:e.target.value}}))}/></div>
                <label className="flex items-center gap-2 text-[11px]"><input type="checkbox" checked={availability.quietHours.enabled} onChange={(e)=>setAvailability((v)=>({...v,quietHours:{...v.quietHours,enabled:e.target.checked}}))}/>Enable quiet hours</label>
                <Button type="button" size="sm" variant="outline" onClick={()=>void saveAvailability()}>Save availability</Button>
              </div>
              <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border bg-muted/20 p-3">
                <div><p className="text-xs font-medium">Browser live alerts</p><p className="text-[11px] text-muted-foreground">Show a desktop alert while you are signed in to the support portal.</p></div>
                <Button type="button" size="sm" variant="outline" onClick={async()=>{
                  if (!("Notification" in window)) return toast({title:"Browser alerts unavailable",variant:"destructive"});
                  const permission=await Notification.requestPermission();toast({title:permission==="granted"?"Browser alerts enabled":"Browser alerts were not enabled"});
                }}>Enable</Button>
              </div>
              <div className="rounded-lg border border-border/50 bg-muted/20 p-3 text-xs text-muted-foreground">
                There are no member-level email or WhatsApp switches. Contact an owner to change the workspace-wide channels or update your saved notification contact.
              </div>
            </CardContent>
          </Card>

          <Card className="border border-border/50 rounded-xl shadow-none">
            <CardHeader className="px-5 pt-5 pb-4 border-b border-border/30">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Lock className="h-4 w-4 text-warning" /> Change Password
              </CardTitle>
            </CardHeader>
            <CardContent className="p-5">
              <form onSubmit={handleChangePassword} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="current-password" className="text-xs font-medium text-muted-foreground">Current Password</Label>
                  <Input id="current-password" type="password" placeholder="••••••••"
                    value={passwords.currentPassword}
                    onChange={(e) => setPasswords(p => ({ ...p, currentPassword: e.target.value }))}
                    required className="h-9 rounded-lg text-sm border-border/60" />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="new-password" className="text-xs font-medium text-muted-foreground">New Password</Label>
                    <Input id="new-password" type="password" placeholder="••••••••"
                      value={passwords.newPassword}
                      onChange={(e) => setPasswords(p => ({ ...p, newPassword: e.target.value }))}
                      required minLength={6} className="h-9 rounded-lg text-sm border-border/60" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="confirm-password" className="text-xs font-medium text-muted-foreground">Confirm Password</Label>
                    <Input id="confirm-password" type="password" placeholder="••••••••"
                      value={passwords.confirmPassword}
                      onChange={(e) => setPasswords(p => ({ ...p, confirmPassword: e.target.value }))}
                      required minLength={6} className="h-9 rounded-lg text-sm border-border/60" />
                  </div>
                </div>
                <div className="pt-2">
                  <Button type="submit" size="sm" className="h-8 rounded-lg text-xs px-5 gap-1.5" loading={changingPassword}>
                    <ShieldCheck className="w-3.5 h-3.5" />
                    Update Password
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card className="border border-border/50 rounded-xl shadow-none">
            <CardContent className="p-4 flex items-center justify-between gap-4">
              <div className="flex items-start gap-2.5">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div>
                  <p className="text-sm font-medium">Need Help?</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Contact an administrator for advanced security settings.</p>
                </div>
              </div>
              <Button variant="outline" size="sm" className="h-8 shrink-0 rounded-lg border-primary/20 text-xs text-primary hover:bg-primary/5">
                Support Desk
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
