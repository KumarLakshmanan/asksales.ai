"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { AuthProvider } from "@/contexts/AuthContext";
import { WebSocketProvider } from "@/contexts/WebSocketContext";
import { ViewModeProvider } from "@/contexts/ViewModeContext";
import { AgentProvider } from "@/contexts/AgentContext";
import { WebSocketErrorBoundary } from "@/components/WebSocketErrorBoundary";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "next-themes";
import { PreferencesProvider } from "@/contexts/PreferencesContext";
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { preserveFollowUpRecoveryNavigation } from "@/lib/follow-up-save-recovery";
import { installUnsavedNavigation } from "@/hooks/use-unsaved-changes";

export function Providers({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  useEffect(installUnsavedNavigation, []);
  useEffect(preserveFollowUpRecoveryNavigation, [pathname]);
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <PreferencesProvider>
            <WebSocketErrorBoundary>
              <WebSocketProvider>
                <ViewModeProvider>
                  <AgentProvider>
                    <TooltipProvider>
                      <Toaster />
                      {children}
                    </TooltipProvider>
                  </AgentProvider>
                </ViewModeProvider>
              </WebSocketProvider>
            </WebSocketErrorBoundary>
          </PreferencesProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
