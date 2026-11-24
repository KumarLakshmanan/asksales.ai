"use client";

import { useEffect, useRef, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { usePreferences } from "@/contexts/PreferencesContext";
import { useToast } from "@/hooks/use-toast";

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const { isAuthenticated } = useAuth();
  const { updatePreferences, isLoading: preferencesLoading } = usePreferences();
  const { toast } = useToast();
  const [mounted, setMounted] = useState(false);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => setMounted(true), []);

  const effectiveTheme = mounted
    ? theme === "system" || !theme
      ? resolvedTheme
      : theme
    : null;
  const isDark = effectiveTheme === "dark";

  const toggleTheme = async () => {
    if (inFlight.current || !mounted || preferencesLoading) return;
    inFlight.current = true;
    const nextTheme = isDark ? "light" : "dark";
    setTheme(nextTheme);
    document.documentElement.classList.toggle("dark", nextTheme === "dark");
    document.documentElement.style.colorScheme = nextTheme;
    if (isAuthenticated) {
      setSaving(true);
      try {
        await updatePreferences({ theme: nextTheme });
      } catch {
        toast({ title: "Theme changed for this view", description: "Your account preference could not be saved. The theme may revert after reload.", variant: "destructive" });
      } finally {
        setSaving(false);
      }
    }
    inFlight.current = false;
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("text-muted-foreground hover:bg-primary/10 hover:text-primary", className)}
      onClick={() => void toggleTheme()}
      disabled={!mounted || preferencesLoading || saving}
      aria-busy={saving}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}
