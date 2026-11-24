"use client";

import { useId } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

type PaidAdsFilterSelectProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  items: string[];
  itemLabel?: (value: string) => string;
  className?: string;
};

export function PaidAdsFilterSelect({ label, value, onChange, items, itemLabel, className }: PaidAdsFilterSelectProps) {
  const id = useId();

  return (
    <div className={cn("min-w-0 space-y-1", className)}>
      <label htmlFor={id} className="block break-words text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} aria-label={label} className="h-auto min-h-9 gap-2 [&>span]:line-clamp-none">
          <span className="min-w-0 flex-1 break-words text-left">
            <SelectValue />
          </span>
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item} value={item} className="capitalize">
              {itemLabel ? itemLabel(item) : item.replaceAll("_", " ")}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
