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
  Users,
  Webhook,
  LogOut
} from "lucide-react";
import { InstagramOAuthStatus } from "./types";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect } from "react";
import api from "@/lib/api";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { ChannelAccountSelector } from "@/components/integrations/ChannelAccountSelector";
import { providerDeveloperToolsEnabled } from "@/lib/feature-flags";

interface InstagramOfficialAPIProps {
  showConnectionActions?: boolean;
  oauthStatus: InstagramOAuthStatus | null;
  refreshingToken: boolean;
  onOAuthConnect: () => void;
  onRefreshToken: () => Promise<void>;
  onAccountChanged?: () => Promise<void> | void;
  onDisconnect?: () => Promise<void>;
}

export function InstagramOfficialAPI({
  showConnectionActions = true,
  oauthStatus,
  refreshingToken,
  onOAuthConnect,
  onRefreshToken,
  onAccountChanged,
  onDisconnect
}: InstagramOfficialAPIProps) {
  const isOfficialConnected = oauthStatus?.officialApi.connected;
  const requiresReconnect = oauthStatus?.officialApi.requiresReconnect === true;
  const readinessErrorCode = oauthStatus?.officialApi.readinessErrorCode;
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
    clientId: "",
    clientSecret: "",
    accessToken: "",
    pageId: "",
    igUserId: ""
  });

  useEffect(() => {
    if (oauthStatus?.officialApi.instagramAccountId) {
      setManualForm(prev => ({
        ...prev,
        igUserId: prev.igUserId || oauthStatus.officialApi.instagramAccountId || "",
        pageId: prev.pageId || oauthStatus.officialApi.instagramAccountId || "",
      }));
    }
  }, [oauthStatus?.officialApi.instagramAccountId]);

  const handleManualSave = async () => {
    try {
      setSaving(true);
      await api.post("/api/instagram/oauth/manual", manualForm);
      toast({ title: "Settings Saved", description: "Manual API settings have been updated." });
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
          <div className="w-6 h-6 rounded bg-purple-500/10 flex items-center justify-center text-purple-600 border border-purple-500/20">
            <Link2 className="w-3 h-3" />
          </div>
          <span className="text-xs font-bold">Instagram API Connection</span>
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
                    <p className="text-xs font-bold">Meta Graph API Status</p>
                  <p className="text-xs text-muted-foreground uppercase tracking-widest">
                    {isOfficialConnected ? "Connected" : requiresReconnect ? "Reconnect Required" : "Connection Required"}
                  </p>
                </div>
              </div>
              {!isOfficialConnected ? (
                 showConnectionActions && <Button size="sm" onClick={onOAuthConnect} className="h-7 text-xs px-3 font-black uppercase tracking-widest rounded-md bg-gradient-to-r from-[#f09433] via-[#dc2743] to-[#bc1888] hover:opacity-90 text-white shadow-sm transition-all active:scale-95">
                   {requiresReconnect ? "Reconnect" : "Connect"}
                 </Button>
              ) : (
                 <div className="flex items-center gap-1.5">
                   <Badge variant="default" className="h-5 text-xs px-1.5 uppercase font-black tracking-widest bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 hover:bg-emerald-500/20">
                     Connected
                   </Badge>
                   {showConnectionActions && <Button variant="ghost" size="icon" className="h-7 w-7 rounded-md text-muted-foreground hover:bg-muted shrink-0" onClick={onOAuthConnect} title="Reconnect Instagram">
                     <RefreshCw className="w-3.5 h-3.5" />
                   </Button>}
                   {showConnectionActions && onDisconnect && (
                     <Button variant="ghost" size="icon" className="h-7 w-7 rounded-md text-rose-500 hover:bg-rose-500/10 shrink-0" onClick={onDisconnect} title="Disconnect Instagram">
                       <LogOut className="w-3.5 h-3.5" />
                     </Button>
                   )}
                 </div>
              )}
            </div>

            {requiresReconnect && (
              <div className="border-t border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                Meta rejected the saved authorization. Sign in directly with your Instagram Business or Creator account to restore DM replies.
              </div>
            )}

            {showReadinessWarning && (
              <div className="border-t border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                Instagram is connected, but one provider readiness check needs administrator attention. Reconnecting the same account is not required.
              </div>
            )}


            {isOfficialConnected && (
              <>
                {/* Instagram Profile Card */}
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="border-t border-border/40 p-3"
                  style={{ background: 'linear-gradient(135deg, rgba(131,58,180,0.06) 0%, rgba(253,29,29,0.04) 50%, rgba(252,176,69,0.06) 100%)' }}
                >
                  <div className="flex items-center gap-3">
                    <div className="relative shrink-0">
                      {oauthStatus?.officialApi.profilePicture ? (
                        <img
                          src={oauthStatus.officialApi.profilePicture}
                          alt={oauthStatus.officialApi.username || 'Instagram'}
                          className="w-11 h-11 rounded-xl object-cover border-2 border-purple-500/30 shadow-sm"
                          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                      ) : (
                        <div className="w-11 h-11 rounded-xl flex items-center justify-center border-2 border-purple-500/20" style={{ background: 'linear-gradient(135deg, #833ab4, #fd1d1d, #fcb045)' }}>
                          <span className="text-white font-black text-base">IG</span>
                        </div>
                      )}
                      <div className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-emerald-500 border-2 border-background flex items-center justify-center">
                        <CheckCircle2 className="w-2.5 h-2.5 text-white" />
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold truncate leading-tight">
                        @{oauthStatus?.officialApi.username || 'Instagram Account'}
                      </p>
                      <p className="text-xs text-muted-foreground uppercase tracking-widest font-medium mt-0.5">
                        ID: {oauthStatus?.officialApi.instagramAccountId}
                      </p>
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        <Badge className="h-4 text-xs px-1.5 font-black uppercase tracking-widest bg-purple-500/10 text-purple-600 border border-purple-500/20">
                          Business Account
                        </Badge>
                        {oauthStatus?.officialApi.webhookSubscribed && (
                          <Badge className="h-4 text-xs px-1.5 font-black uppercase tracking-widest bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">
                            <Webhook className="w-2 h-2 mr-1" />Events Active
                          </Badge>
                        )}
                        {oauthStatus?.officialApi.connectionMethod && oauthStatus.officialApi.connectionMethod !== 'manual' && (
                          <Badge className="h-4 text-xs px-1.5 font-black uppercase tracking-widest bg-muted/60 text-muted-foreground border border-border/40">
                            1-Click
                          </Badge>
                        )}
                      </div>
                    </div>
                    {typeof oauthStatus?.officialApi.followersCount === 'number' && (
                      <div className="shrink-0 text-right">
                        <p className="text-sm font-black tabular-nums">
                          {oauthStatus.officialApi.followersCount.toLocaleString()}
                        </p>
                        <div className="flex items-center gap-1 text-muted-foreground">
                          <Users className="w-2.5 h-2.5" />
                          <p className="text-xs uppercase tracking-widest font-bold">Followers</p>
                        </div>
                      </div>
                    )}
                    {showConnectionActions && <ChannelAccountSelector
                      platform="instagram_api"
                      label="Instagram profile"
                      variant="action"
                      onChanged={onAccountChanged}
                    />}
                  </div>

                  {/* Linked Facebook Page */}
                  {oauthStatus?.officialApi.pageName && (
                    <div className="mt-2.5 pt-2.5 border-t border-purple-500/10 flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg bg-[#1877F2]/10 border border-[#1877F2]/20 flex items-center justify-center shrink-0">
                        <span className="text-[#1877F2] font-black text-xs">f</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-bold truncate">{oauthStatus.officialApi.pageName}</p>
                        <p className="text-xs text-muted-foreground uppercase tracking-widest">Facebook Page · ID {oauthStatus.officialApi.pageId}</p>
                      </div>
                      <Badge className="h-4 text-xs px-1.5 font-black uppercase tracking-widest bg-[#1877F2]/10 text-[#1877F2] border border-[#1877F2]/20">
                        Linked
                      </Badge>
                    </div>
                  )}
                </motion.div>

                <div className="flex items-center justify-between p-3 hover:bg-muted/5 transition-colors border-t border-border/40 bg-emerald-500/5">
                  <div className="flex items-center gap-3">
                    <Key className="w-3.5 h-3.5 text-emerald-600/50" />
                    <div>
                       <p className="text-xs font-bold">Token Status</p>
                      <p className="text-xs text-muted-foreground uppercase tracking-widest">
                         {oauthStatus?.officialApi.expiresAt ? `Expires ${new Date(oauthStatus.officialApi.expiresAt).toLocaleDateString()}` : "Never Expires"}
                      </p>
                    </div>
                  </div>
                  <Button 
                    size="sm" 
                    variant="outline" 
                    onClick={onRefreshToken} 
                    loading={refreshingToken}
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
                        value={manualForm.clientId}
                        onChange={e => setManualForm({...manualForm, clientId: e.target.value})}
                        className="h-8 text-xs bg-background/50 border-border/40 rounded-md px-2 font-mono"
                        placeholder="1234567890"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs font-black uppercase tracking-widest text-muted-foreground px-1">App Secret</Label>
                      <Input 
                        type="password"
                        value={manualForm.clientSecret}
                        onChange={e => setManualForm({...manualForm, clientSecret: e.target.value})}
                        className="h-8 text-xs bg-background/50 border-border/40 rounded-md px-2 font-mono"
                        placeholder="••••••••••••••••"
                      />
                    </div>
                    <div className="space-y-1 col-span-2">
                      <Label className="text-xs font-black uppercase tracking-widest text-muted-foreground px-1">Long-Lived Access Token</Label>
                      <Input 
                        type="password"
                        value={manualForm.accessToken}
                        onChange={e => setManualForm({...manualForm, accessToken: e.target.value})}
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
                      <Label className="text-xs font-black uppercase tracking-widest text-muted-foreground px-1">IG User ID</Label>
                      <Input 
                        value={manualForm.igUserId}
                        onChange={e => setManualForm({...manualForm, igUserId: e.target.value})}
                        className="h-8 text-xs bg-background/50 border-border/40 rounded-md px-2 font-mono"
                        placeholder="1784140000"
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
