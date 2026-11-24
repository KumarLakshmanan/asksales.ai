/**
 * IntegrationRequired Component
 * Shows a placeholder UI when a required integration is not connected
 * Provides a connect button that redirects to the integrations page
 */

"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { Link2, Settings, ArrowRight, Sparkles } from "lucide-react";
import { LucideIcon } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

interface IntegrationRequiredProps {
  /** Name of the integration (e.g., "Meta Ads", "Instagram", "Email") */
  integrationName: string;
  /** Description of what the integration enables */
  description: string;
  /** Icon component to display */
  icon?: LucideIcon;
  /** Color class for the icon (e.g., "text-blue-600") */
  iconColorClass?: string;
  /** Optional list of features that require this integration */
  features?: string[];
  /** Custom path to redirect to (defaults to integrations page) */
  integrationPath?: string;
}

export function IntegrationRequired({
  integrationName,
  description,
  icon,
  iconColorClass = "text-primary",
  features = [],
  integrationPath = "/dashboard/integrations",
}: IntegrationRequiredProps) {
  const router = useRouter();
  // Use Link2 as fallback if icon is undefined
  const IconComponent = icon || Link2;

  return (
    <div className="flex items-center justify-center min-h-[50vh] p-4">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-md"
      >
        <Card className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-xl shadow-xl overflow-hidden relative group">
          <CardHeader className="text-center p-6 pb-4 space-y-4 relative z-10">
            <div className="mx-auto relative">
               <div className="relative w-16 h-16 rounded-xl bg-primary/10 flex items-center justify-center text-primary border border-primary/20 shadow-lg group-hover:scale-105 transition-transform duration-500">
                  <IconComponent className={cn("h-7 w-7", iconColorClass)} />
               </div>
            </div>
            
            <div className="space-y-1.5">
              <CardTitle className="text-lg font-bold tracking-tight">Connect {integrationName}</CardTitle>
              <CardDescription className="text-xs font-medium text-muted-foreground leading-relaxed px-2">{description}</CardDescription>
            </div>
          </CardHeader>

          <CardContent className="p-6 pt-0 text-center space-y-6 relative z-10">
            {features.length > 0 && (
              <div className="text-left bg-primary/5 rounded-xl p-4 border border-primary/10 space-y-3">
                <div className="flex items-center gap-2">
                   <Sparkles className="w-3.5 h-3.5 text-primary" />
                   <p className="text-[9px] font-black uppercase tracking-widest text-primary/80">Capabilities</p>
                </div>
                <ul className="grid grid-cols-1 gap-2">
                  {features.map((feature, index) => (
                    <li key={index} className="flex items-center gap-2.5 text-xs font-bold text-muted-foreground/80 group/item">
                      <div className="h-1 w-1 rounded-full bg-primary/40 group-hover/item:bg-primary transition-colors" />
                      {feature}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="space-y-3">
               <Button
                 className="w-full h-11 rounded-lg bg-primary hover:bg-primary/90 text-white shadow-lg shadow-primary/20 font-bold text-xs active:scale-95 transition-all group/btn"
                 onClick={() => router.push(integrationPath)}
               >
                 Integrate Now
                 <ArrowRight className="h-3.5 w-3.5 ml-2 group-hover/btn:translate-x-1 transition-transform" />
               </Button>
               
               <Button
                 variant="ghost"
                 className="w-full h-10 rounded-lg text-muted-foreground hover:text-foreground font-bold text-[10px] uppercase tracking-widest active:scale-95 transition-all"
                 onClick={() => router.push("/dashboard/integrations")}
               >
                 <Settings className="h-3.5 w-3.5 mr-2 opacity-40" />
                 Manage Integrations
               </Button>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
