"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { 
  RefreshCw, 
  Key,
  CheckCircle2,
  XCircle,
  Link2,
  ChevronDown,
  Save,
  LogOut,
  Webhook,
  Instagram
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect } from "react";
import api from "@/lib/api";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { ChannelAccountSelector } from "@/components/integrations/ChannelAccountSelector";
import { providerDeveloperToolsEnabled } from "@/lib/feature-flags";

interface FacebookOAuthStatus {
  officialApi: {
    connected: boolean;
    requiresReconnect?: boolean;
    username: string | null;
    pageId?: string | null;
    tokenExpired: boolean;
    expiresAt: string | null;
    connectionMethod?: 'oauth' | 'manual' | null;
    pagePictureUrl?: string | null;
    webhookSubscribed?: boolean;
    instagramConnected?: boolean;
    instagramUsername?: string | null;
    instagramAccountId?: string | null;
    grantedScopes?: string[];
    declinedScopes?: string[];
    readinessErrorCode?: string | null;
    lastVerifiedAt?: string | null;
  };
}

interface FacebookOfficialAPIProps {
  showConnectionActions?: boolean;
  status: FacebookOAuthStatus | null;
  refreshing: boolean;
  onConnect: () => void;
  onRefresh: () => Promise<void>;
  onAccountChanged?: () => Promise<void> | void;
  onDisconnect: () => Promise<void>;
}

export function FacebookOfficialAPI({
  showConnectionActions = true,
  status,
  refreshing,
  onConnect,
  onRefresh,
  onAccountChanged,
  onDisconnect
}: FacebookOfficialAPIProps) {
  const isOfficialConnected = status?.officialApi.connected;
  const requiresReconnect = status?.officialApi.requiresReconnect === true;
  const readinessErrorCode = status?.officialApi.readinessErrorCode;
  // App-review status is an administrator concern. Keep actionable provider
  // readiness errors visible without exposing Meta's review workflow to clients.
  const showReadinessWarning = Boolean(
    isOfficialConnected && readinessErrorCode && readinessErrorCode !== "APP_REVIEW",
  );
  const { toast } = useToast();
  
  const [mode, setMode] = useState<'oauth' | 'manual'>('oauth');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  
  const [manualForm, setManualForm] = useState({
    appId: "",
    appSecret: "",
    pageAccessToken: "",
    pageId: "",
    pageName: ""
  });

  useEffect(() => {
    if (status?.officialApi.pageId) {
      setManualForm(prev => ({
        ...prev,
        pageId: prev.pageId || status.officialApi.pageId || "",
        pageName: prev.pageName || status.officialApi.username || "",
      }));
    }
  }, [status?.officialApi.pageId, status?.officialApi.username]);

  const handleManualSave = async () => {
    try {
      if (!manualForm.appId || !manualForm.appSecret || !manualForm.pageAccessToken || !manualForm.pageId) {
        toast({ title: "Missing fields", description: "App ID, App Secret, Page Access Token, and Page ID are required.", variant: "destructive" });
        return;
      }
      setSaving(true);
      const res = await api.post<{ success: boolean; error?: string }>("/api/facebook/manual-credentials", manualForm);
      if (res.success) {
        toast({ title: "Settings Saved", description: "Manual API settings have been updated." });
        onRefresh();
      } else {
        throw new Error(res.error || "Failed to save settings");
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Failed to save settings";
      toast({ title: "Save Failed", description: message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-border/40 bg-card/30 overflow-hidden divide-y divide-border/40 w-full shadow-lg shadow-black/5">
      {/* Header Row with Segmented Control */}
      <div className="flex items-center justify-between p-2 bg-muted/10">
        <div className="flex items-center gap-2 px-2">
          <div className="w-6 h-6 rounded bg-blue-500/10 flex items-center justify-center text-blue-600 border border-blue-500/20">
            <Link2 className="w-3 h-3" />
          </div>
          <span className="text-xs font-bold">Facebook API Connection</span>
        </div>
        
        {/* Segmented Control */}
        <div className="flex bg-background/50 p-0.5 rounded-lg border border-border/40">
          <button
            onClick={() => setMode('oauth')}
            className={cn(
              "px-3 py-1 rounded-md text-xs font-black uppercase tracking-widest transition-all",
              mode === 'oauth' ? "bg-black text-white shadow-sm" : "text-muted-foreground hover:text-foreground"
            )}
          >
            1-Click Auth
          </button>
          {providerDeveloperToolsEnabled && (
            <button
              onClick={() => setMode('manual')}
              className={cn(
                "px-3 py-1 rounded-md text-xs font-black uppercase tracking-widest transition-all",
                mode === 'manual' ? "bg-black text-white shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              Dev App
            </button>
          )}
        </div>
      </div>

      <AnimatePresence mode="wait">
        {mode === 'oauth' ? (
          <motion.div
            key="oauth"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="p-0"
          >
            <div className="flex items-center justify-between p-3 hover:bg-muted/5 transition-colors">
              <div className="flex items-center gap-3">
                {isOfficialConnected ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /> : <XCircle className="w-3.5 h-3.5 text-muted-foreground/40" />}
                <div>
                  <p className="text-xs font-bold">Meta Graph Status</p>
                  <p className="text-xs text-muted-foreground uppercase tracking-widest">
                    {isOfficialConnected ? "Connected" : requiresReconnect ? "Reconnect Required" : "Connection Required"}
                  </p>
                </div>
              </div>
              {!isOfficialConnected ? (
                 showConnectionActions && <Button size="sm" onClick={onConnect} className="h-7 text-xs px-3 font-black uppercase tracking-widest rounded-md bg-[#1877F2] hover:bg-[#1864D9] text-white shadow-sm transition-all active:scale-95">
                   {requiresReconnect ? "Reconnect" : "Connect"}
                 </Button>
              ) : (
                <Badge variant="default" className="h-5 text-xs px-1.5 uppercase font-black tracking-widest bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 hover:bg-emerald-500/20">
                  Connected
                </Badge>
              )}
            </div>

            {requiresReconnect && (
              <div className="border-t border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                Meta rejected the saved Page authorization. Reconnect through a Facebook account that manages this Page to restore Messenger replies.
              </div>
            )}

            {showReadinessWarning && (
              <div className="border-t border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                Facebook is connected, but one provider readiness check needs administrator attention. Reconnecting the same Page is not required.
              </div>
            )}

            {isOfficialConnected && (
              <>
                {/* Profile Card */}
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="border-t border-border/40 bg-[#1877F2]/5 p-3"
                >
                  <div className="flex items-center gap-3">
                    <div className="relative shrink-0">
                      {status?.officialApi.pagePictureUrl ? (
                        <img
                          src={status.officialApi.pagePictureUrl}
                          alt={status.officialApi.username || 'Page'}
                          className="w-11 h-11 rounded-xl object-cover border-2 border-[#1877F2]/30 shadow-sm"
                          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                      ) : (
                        <div className="w-11 h-11 rounded-xl bg-[#1877F2]/10 border-2 border-[#1877F2]/20 flex items-center justify-center">
                          <span className="text-[#1877F2] font-black text-base">f</span>
                        </div>
                      )}
                      <div className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-emerald-500 border-2 border-background flex items-center justify-center">
                        <CheckCircle2 className="w-2.5 h-2.5 text-white" />
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold truncate leading-tight">{status?.officialApi.username || 'Facebook Page'}</p>
                      <p className="text-xs text-muted-foreground uppercase tracking-widest font-medium mt-0.5">
                        Page ID: {status?.officialApi.pageId}
                      </p>
                      <div className="flex items-center gap-2 mt-1.5">
                        <Badge className="h-4 text-xs px-1.5 font-black uppercase tracking-widest bg-[#1877F2]/10 text-[#1877F2] border border-[#1877F2]/20 hover:bg-[#1877F2]/20">
                          Facebook Page
                        </Badge>
                        {status?.officialApi.webhookSubscribed && (
                          <Badge className="h-4 text-xs px-1.5 font-black uppercase tracking-widest bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">
                            <Webhook className="w-2 h-2 mr-1" />Events Active
                          </Badge>
                        )}
                        {status?.officialApi.connectionMethod && status.officialApi.connectionMethod !== 'manual' && (
                          <Badge className="h-4 text-xs px-1.5 font-black uppercase tracking-widest bg-muted/60 text-muted-foreground border border-border/40">
                            1-Click
                          </Badge>
                        )}
                      </div>
                    </div>
                    {showConnectionActions && <div className="flex items-center gap-1.5 shrink-0">
                      <ChannelAccountSelector
                        platform="facebook_api"
                        label="Facebook Page"
                        variant="action"
                        onChanged={onAccountChanged}
                      />
                      <Button variant="ghost" size="icon" className="h-7 w-7 rounded-md text-muted-foreground hover:bg-muted" onClick={onConnect} title="Reconnect Facebook">
                        <RefreshCw className="w-3.5 h-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 rounded-md text-rose-500 hover:bg-rose-500/10" onClick={onDisconnect} title="Disconnect Facebook">
                        <LogOut className="w-3.5 h-3.5" />
                      </Button>
                    </div>}
                  </div>

                  {/* Instagram linked account */}
                  {status?.officialApi.instagramConnected && (
                    <div className="mt-2.5 pt-2.5 border-t border-[#1877F2]/10 flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-purple-500/20 to-pink-500/20 border border-purple-500/20 flex items-center justify-center shrink-0">
                        <Instagram className="w-3.5 h-3.5 text-purple-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-bold truncate">@{status.officialApi.instagramUsername}</p>
                        <p className="text-xs text-muted-foreground uppercase tracking-widest">Linked account · connect Instagram separately</p>
                      </div>
                      <Badge className="h-4 text-xs px-1.5 font-black uppercase tracking-widest bg-purple-500/10 text-purple-600 border border-purple-500/20">
                        Linked
                      </Badge>
                    </div>
                  )}
                </motion.div>

                <div className="flex items-center justify-between p-3 hover:bg-muted/5 transition-colors border-t border-border/40 bg-emerald-500/5">
                  <div className="flex items-center gap-3">
                    <Key className="w-3.5 h-3.5 text-emerald-600/50" />
                    <div>
                      <p className="text-xs font-bold">Access Token</p>
                      <p className="text-xs text-muted-foreground uppercase tracking-widest">
                         {status?.officialApi.expiresAt ? `Valid until ${new Date(status.officialApi.expiresAt).toLocaleDateString()}` : "Persistent Access"}
                      </p>
                    </div>
                  </div>
                  <Button 
                    size="sm" 
                    variant="outline" 
                    onClick={onRefresh} 
                    loading={refreshing}
                    loadingText="Refresh"
                    className="h-7 text-xs px-3 font-black uppercase tracking-widest rounded-md border-emerald-500/20 text-emerald-600 hover:bg-emerald-500/10 gap-1.5"
                  >
                    <RefreshCw className="w-3 h-3" />
                    Refresh
                  </Button>
                </div>
              </>
            )}
          </motion.div>
        ) : (
          <motion.div
            key="manual"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="p-3 bg-muted/5 space-y-3"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-bold">Manual App Credentials</p>
                <p className="text-xs text-muted-foreground uppercase tracking-widest mt-0.5">Use your private Meta Developer Application</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 rounded-md hover:bg-muted"
                onClick={() => setShowAdvanced(!showAdvanced)}
              >
                <ChevronDown className={cn("w-4 h-4 text-muted-foreground transition-transform", showAdvanced && "rotate-180")} />
              </Button>
            </div>
            
            <AnimatePresence>
              {showAdvanced && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden"
                >
                  {isOfficialConnected && (
                    <p className="text-xs text-muted-foreground px-1 mb-2">
                      Already connected. Leave secret/token fields blank to keep existing credentials.
                    </p>
                  )}
                  <div className="grid grid-cols-2 gap-2 pt-2 border-t border-border/40">
                    <div className="space-y-1">
                      <Label className="text-xs font-black uppercase tracking-widest text-muted-foreground px-1">App ID</Label>
                      <Input 
                        value={manualForm.appId}
                        onChange={e => setManualForm({...manualForm, appId: e.target.value})}
                        className="h-8 text-xs bg-background/50 border-border/40 rounded-md px-2 font-mono"
                        placeholder="123456789"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs font-black uppercase tracking-widest text-muted-foreground px-1">App Secret</Label>
                      <Input 
                        type="password"
                        value={manualForm.appSecret}
                        onChange={e => setManualForm({...manualForm, appSecret: e.target.value})}
                        className="h-8 text-xs bg-background/50 border-border/40 rounded-md px-2 font-mono"
                        placeholder="••••••••"
                      />
                    </div>
                    <div className="space-y-1 col-span-2">
                      <Label className="text-xs font-black uppercase tracking-widest text-muted-foreground px-1">Page Access Token</Label>
                      <Input 
                        type="password"
                        value={manualForm.pageAccessToken}
                        onChange={e => setManualForm({...manualForm, pageAccessToken: e.target.value})}
                        className="h-8 text-xs bg-background/50 border-border/40 rounded-md px-2 font-mono"
                        placeholder="EAAB..."
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs font-black uppercase tracking-widest text-muted-foreground px-1">Facebook Page ID</Label>
                      <Input 
                        value={manualForm.pageId}
                        onChange={e => setManualForm({...manualForm, pageId: e.target.value})}
                        className="h-8 text-xs bg-background/50 border-border/40 rounded-md px-2 font-mono"
                        placeholder="1092837465"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs font-black uppercase tracking-widest text-muted-foreground px-1">Page Name</Label>
                      <Input 
                        value={manualForm.pageName}
                        onChange={e => setManualForm({...manualForm, pageName: e.target.value})}
                        className="h-8 text-xs bg-background/50 border-border/40 rounded-md px-2 font-mono"
                        placeholder="My Business Page"
                      />
                    </div>
                  </div>
                  
                  <div className="pt-3">
                    <Button 
                      onClick={handleManualSave}
                      loading={saving}
                      loadingText="Save Developer Config"
                      className="w-full h-8 rounded-md bg-black hover:bg-zinc-800 text-white font-black text-xs uppercase tracking-widest shadow-sm active:scale-95 transition-all"
                    >
                      <Save className="w-3 h-3 mr-2" />
                      Save Developer Config
                    </Button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
