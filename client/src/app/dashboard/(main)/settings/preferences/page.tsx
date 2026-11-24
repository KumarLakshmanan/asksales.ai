"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Settings, Globe, Clock, Monitor, Check, RefreshCw, Calendar, Moon, Coins } from "lucide-react";
import { PageErrorState, PageLoadingState } from "@/components/ui/page-state";
import { usePreferences, type UserPreferences } from "@/contexts/PreferencesContext";
import { PageHeader } from "@/components/ui/page-header";

const LANGUAGES = [
  { value: "en", label: "English", flag: "🇺🇸" }, { value: "es", label: "Español", flag: "🇪🇸" },
  { value: "fr", label: "Français", flag: "🇫🇷" }, { value: "de", label: "Deutsch", flag: "🇩🇪" },
  { value: "hi", label: "हिन्दी", flag: "🇮🇳" }, { value: "ta", label: "தமிழ்", flag: "🇮🇳" },
];

const TIMEZONES = [
  { value: "Asia/Kolkata", label: "India Standard Time (IST)" },
  { value: "UTC", label: "Coordinated Universal Time (UTC)" },
  { value: "America/New_York", label: "Eastern Time (ET)" },
  { value: "America/Chicago", label: "Central Time (CT)" },
  { value: "America/Denver", label: "Mountain Time (MT)" },
  { value: "America/Los_Angeles", label: "Pacific Time (PT)" },
  { value: "Europe/London", label: "London (GMT/BST)" },
  { value: "Europe/Paris", label: "Paris (CET/CEST)" },
  { value: "Asia/Tokyo", label: "Japan Standard Time (JST)" },
  { value: "Australia/Sydney", label: "Australian Eastern Time (AET)" },
];

const DATE_FORMATS = [
  { value: "MM/DD/YYYY", label: "MM/DD/YYYY", preview: "12/31/2024" },
  { value: "DD/MM/YYYY", label: "DD/MM/YYYY", preview: "31/12/2024" },
  { value: "YYYY-MM-DD", label: "YYYY-MM-DD", preview: "2024-12-31" },
  { value: "MMM D, YYYY", label: "MMM D, YYYY", preview: "Dec 31, 2024" },
];

const TIME_FORMATS = [
  { value: "12h", label: "12-hour (AM/PM)", preview: "11:59 PM" },
  { value: "24h", label: "24-hour", preview: "23:59" },
];

const LOCALES = [
  { value: "en-US", label: "United States (English)" },
  { value: "en-GB", label: "United Kingdom (English)" },
  { value: "es-ES", label: "Spain (Español)" },
  { value: "fr-FR", label: "France (Français)" },
  { value: "de-DE", label: "Germany (Deutsch)" },
  { value: "hi-IN", label: "India (हिन्दी)" },
  { value: "ta-IN", label: "India (தமிழ்)" },
];

const CURRENCIES = [
  ["USD", "US Dollar"], ["EUR", "Euro"], ["GBP", "British Pound"], ["INR", "Indian Rupee"],
  ["CAD", "Canadian Dollar"], ["AUD", "Australian Dollar"], ["JPY", "Japanese Yen"], ["SGD", "Singapore Dollar"],
] as const;

const THEMES = [
  { value: "system", label: "System", description: "Follow this device’s appearance." },
  { value: "light", label: "Light", description: "Always use the light color theme." },
  { value: "dark", label: "Dark", description: "Always use the dark color theme." },
] as const;

export default function PreferencesPage() {
  const { toast } = useToast();
  const { preferences, isLoading, error, refresh, updatePreferences } = usePreferences();
  const [saving, setSaving] = useState(false);
  const [prefs, setPrefs] = useState<UserPreferences>(preferences);

  const fetchPreferences = useCallback(async () => {
    await refresh();
  }, [refresh]);

  useEffect(() => { setPrefs(preferences); }, [preferences]);

  const handleUpdate = (updated: Partial<UserPreferences>) => {
    setPrefs(prev => ({ ...prev, ...updated }));
  };

  const savePreferences = async () => {
    try {
      setSaving(true);
      await updatePreferences(prefs);
      toast({ title: "Preferences Saved", description: "Your account settings have been updated" });
    } catch { toast({ title: "Error", description: "Failed to update preferences", variant: "destructive" }); }
    finally { setSaving(false); }
  };

  if (isLoading) {
    return <PageLoadingState label="Loading preferences…" />;
  }

  if (error) {
    return <PageErrorState title="Preferences unavailable" description="We could not load your saved preferences." reset={fetchPreferences} />;
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-6 px-4 py-5 sm:px-6 lg:px-8">
      <PageHeader
        icon={Settings}
        title="Preferences"
        subtitle="Customize language, date formats, appearance, and currency"
        actions={<div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" className="h-8 rounded-lg text-xs gap-1.5" onClick={() => void fetchPreferences()}>
            <RefreshCw className="w-3.5 h-3.5" /> Revert changes
          </Button>
          <Button size="sm" className="h-8 rounded-lg text-xs px-4 gap-1.5" onClick={savePreferences} loading={saving} loadingText="Saving…">
            <Check className="w-3.5 h-3.5" />
            Save preferences
          </Button>
        </div>}
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">

        {/* Localization & Formatting */}
        <div className="space-y-5">
          {/* Language & Timezone */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-muted/35 text-primary">
                <Globe className="w-4 h-4" />
              </div>
              <h2 className="text-sm font-semibold">Language & Region</h2>
            </div>
            <Card className="rounded-xl border border-border/50 shadow-none">
              <CardContent className="p-5 space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="preferences-language" className="text-xs font-medium text-muted-foreground">Language</Label>
                  <Select value={prefs.language} onValueChange={(v) => handleUpdate({ language: v })}>
                    <SelectTrigger id="preferences-language" className="h-9 rounded-lg border-border/60 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LANGUAGES.map(lang => (
                        <SelectItem key={lang.value} value={lang.value}>
                          <div className="flex items-center gap-2"><span>{lang.flag}</span><span>{lang.label}</span></div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="preferences-locale" className="text-xs font-medium text-muted-foreground">Locale</Label>
                  <Select value={prefs.locale} onValueChange={(v) => handleUpdate({ locale: v })}>
                    <SelectTrigger id="preferences-locale" className="h-9 rounded-lg border-border/60 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {LOCALES.map(locale => <SelectItem key={locale.value} value={locale.value}>{locale.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">Controls number and currency formatting throughout the app.</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="preferences-timezone" className="text-xs font-medium text-muted-foreground">Timezone</Label>
                  <Select value={prefs.timezone} onValueChange={(v) => handleUpdate({ timezone: v })}>
                    <SelectTrigger id="preferences-timezone" className="h-9 rounded-lg border-border/60 text-sm">
                      <div className="flex items-center gap-2">
                        <Clock className="h-3.5 w-3.5 text-primary" />
                        <SelectValue />
                      </div>
                    </SelectTrigger>
                    <SelectContent>
                      {TIMEZONES.map(tz => (
                        <SelectItem key={tz.value} value={tz.value}>{tz.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Formatting */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center text-indigo-600">
                <Calendar className="w-4 h-4" />
              </div>
              <h2 className="text-sm font-semibold">Date &amp; Time Formats</h2>
            </div>
            <Card className="rounded-xl border border-border/50 shadow-none">
              <CardContent className="p-5">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="preferences-date-format" className="text-xs font-medium text-muted-foreground">Date Format</Label>
                    <Select value={prefs.dateFormat} onValueChange={(v) => handleUpdate({ dateFormat: v })}>
                      <SelectTrigger id="preferences-date-format" className="h-9 rounded-lg border-border/60 text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {DATE_FORMATS.map(df => (
                          <SelectItem key={df.value} value={df.value}>
                          <div className="flex flex-col"><span>{df.label}</span><span className="text-xs text-muted-foreground">{df.preview}</span></div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="preferences-time-format" className="text-xs font-medium text-muted-foreground">Time Format</Label>
                    <Select value={prefs.timeFormat} onValueChange={(v: UserPreferences["timeFormat"]) => handleUpdate({ timeFormat: v })}>
                      <SelectTrigger id="preferences-time-format" className="h-9 rounded-lg border-border/60 text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {TIME_FORMATS.map(tf => (
                          <SelectItem key={tf.value} value={tf.value}>
                            <div className="flex flex-col"><span>{tf.label}</span><span className="text-xs text-muted-foreground">{tf.preview}</span></div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Appearance */}
        <div className="space-y-5">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-600">
                <Monitor className="w-4 h-4" />
              </div>
              <h2 className="text-sm font-semibold">Appearance</h2>
            </div>
            <Card className="rounded-xl border border-border/50 shadow-none">
              <CardContent className="p-5 space-y-2">
                <div className="space-y-1.5">
                  <Label htmlFor="preferences-theme" className="text-xs font-medium text-muted-foreground">Color theme</Label>
                  <Select value={prefs.theme} onValueChange={(v: UserPreferences["theme"]) => handleUpdate({ theme: v })}>
                    <SelectTrigger id="preferences-theme" className="h-9 rounded-lg border-border/60 text-sm">
                      <div className="flex items-center gap-2"><Moon className="h-3.5 w-3.5" /><SelectValue /></div>
                    </SelectTrigger>
                    <SelectContent>
                      {THEMES.map(theme => <SelectItem key={theme.value} value={theme.value}>{theme.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {THEMES.find(theme => theme.value === prefs.theme)?.description}
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600">
                <Coins className="h-4 w-4" />
              </div>
              <h2 className="text-sm font-semibold">Default Currency</h2>
            </div>
            <Card className="rounded-xl border border-border/50 shadow-none">
              <CardContent className="space-y-1.5 p-5">
                <Label htmlFor="preferences-currency" className="text-xs font-medium text-muted-foreground">Currency for new records and summaries</Label>
                <Select value={prefs.currency} onValueChange={(v) => handleUpdate({ currency: v })}>
                  <SelectTrigger id="preferences-currency" className="h-9 rounded-lg border-border/60 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map(([code, label]) => <SelectItem key={code} value={code}>{code} — {label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Existing invoices, proposals, and campaigns keep the currency saved on each record.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>

      </div>
    </div>
  );
}
