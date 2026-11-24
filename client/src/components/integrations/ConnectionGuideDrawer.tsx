"use client";

import { useState, type ReactNode } from "react";
import { ListChecks, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

interface ConnectionGuideDrawerProps {
  label?: string;
  title: string;
  description: string;
  icon?: LucideIcon;
  children: (close: () => void) => ReactNode;
}

export function ConnectionGuideDrawer({ label = "How to connect", title, description, icon: Icon = ListChecks, children }: ConnectionGuideDrawerProps) {
  const [open, setOpen] = useState(false);

  return <Sheet open={open} onOpenChange={setOpen}>
    <SheetTrigger asChild>
      <Button variant="outline" className="h-10 rounded-xl text-xs font-semibold"><Icon className="mr-2 h-4 w-4" />{label}</Button>
    </SheetTrigger>
    <SheetContent side="right" className="flex h-dvh w-[calc(100vw-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[720px]">
      <SheetHeader className="shrink-0 border-b bg-card px-6 py-5 pr-12 text-left">
        <SheetTitle>{title}</SheetTitle>
        <SheetDescription>{description}</SheetDescription>
      </SheetHeader>
      <div className="min-h-0 flex-1 overflow-y-auto bg-muted/20 p-4 sm:p-6">
        {open && children(() => setOpen(false))}
      </div>
    </SheetContent>
  </Sheet>;
}
