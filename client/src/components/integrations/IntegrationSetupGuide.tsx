"use client";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { BookOpen, Sparkles, type LucideIcon } from "lucide-react";
import { IntegrationDocs, INTEGRATION_DOCS } from "@/components/IntegrationDocs";
import { cn } from "@/lib/utils";

interface IntegrationSetupGuideProps {
  platform: string;
  platformColor?: string;
  icon?: LucideIcon;
  docsKey?: keyof typeof INTEGRATION_DOCS;
  docs?: {
    platform: string;
    overview: string;
    requirements?: string[];
    steps: {
      title: string;
      description: string;
      action?: string;
      link?: { url: string; text: string };
      code?: string;
      note?: string;
      warning?: string;
    }[];
    tips?: string[];
    troubleshooting?: { problem: string; solution: string }[];
  };
}

export function IntegrationSetupGuide({
  platform,
  platformColor = "bg-primary",
  icon: CustomIcon,
  docsKey,
  docs,
}: IntegrationSetupGuideProps) {
  const resolvedDocs = docs || (docsKey ? INTEGRATION_DOCS[docsKey] : null);
  const IconComponent = CustomIcon || Sparkles;

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          variant="outline"
          className="h-10 px-4 rounded-xl font-semibold text-xs gap-2 border-border/40 hover:bg-muted/50 transition-all"
        >
          <BookOpen className="w-3.5 h-3.5 text-muted-foreground" />
          Setup Guide
        </Button>
      </SheetTrigger>
      <SheetContent
        side="right"
        className="w-full sm:w-[540px] border-l border-border/40 bg-card/95 backdrop-blur-3xl p-0"
      >
        <div className="h-full flex flex-col">
          <SheetHeader
            className={cn(
              "p-4 border-b border-border/40",
              platformColor !== "bg-primary" && `${platformColor}/5`
            )}
          >
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  "w-8 h-8 rounded-lg flex items-center justify-center text-white shadow-lg",
                  platformColor
                )}
              >
                <IconComponent className="w-4 h-4" />
              </div>
              <div>
                <SheetTitle className="text-sm font-semibold tracking-tight">
                  Setup Guide
                </SheetTitle>
                <SheetDescription className="text-xs text-muted-foreground mt-0.5">
                  Step-by-step instructions
                </SheetDescription>
              </div>
            </div>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-4 custom-scrollbar bg-card/30">
            {resolvedDocs ? (
              <IntegrationDocs
                title={`${platform} Guide`}
                docs={resolvedDocs}
                embedded={true}
                className="border-none bg-transparent p-0 shadow-none ring-0"
              />
            ) : (
              <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
                No documentation available yet.
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
