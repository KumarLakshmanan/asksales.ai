"use client";
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Palette, Plus, ChevronDown } from 'lucide-react';
import type { BrandToolkit } from './types';

interface BrandToolkitBarProps {
  /** Compact = just the dropdown button; full = shows active toolkit preview bar */
  variant?: 'compact' | 'full';
  selectedToolkit: BrandToolkit | null;
  brandToolkits: BrandToolkit[];
  loadingToolkits: boolean;
  onSelectToolkit: (toolkit: BrandToolkit) => void;
  onCreateToolkit: () => void;
}

export default function BrandToolkitBar({
  variant = 'compact',
  selectedToolkit,
  brandToolkits,
  loadingToolkits,
  onSelectToolkit,
  onCreateToolkit,
}: BrandToolkitBarProps) {
  const dropdown = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Palette className="w-4 h-4 text-purple-600 dark:text-purple-400" />
          <span className="text-sm">
            {loadingToolkits ? 'Loading...' : selectedToolkit?.name || selectedToolkit?.brandName || 'No Brand'}
          </span>
          <ChevronDown className="w-4 h-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {brandToolkits.map((toolkit) => (
          <DropdownMenuItem
            key={toolkit.id}
            onClick={() => onSelectToolkit(toolkit)}
            className={selectedToolkit?.id === toolkit.id ? 'bg-muted' : ''}
          >
            <div className="flex items-center gap-2">
              {toolkit.primaryBrandColor && (
                <div
                  className="w-4 h-4 rounded-full border"
                  style={{ backgroundColor: toolkit.primaryBrandColor }}
                />
              )}
              <span>{toolkit.name}</span>
              {toolkit.isDefault && (
                <Badge variant="secondary" className="text-xs ml-auto">Default</Badge>
              )}
            </div>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onCreateToolkit}>
          <Plus className="w-4 h-4 mr-2" />
          Create New Brand
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  if (variant === 'compact') return dropdown;

  // Full variant – show the active toolkit preview bar
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">{dropdown}</div>
      {selectedToolkit && (
        <div className="p-3 bg-gradient-to-r from-purple-50 to-violet-50 dark:from-[#1f1d3a] dark:to-[#1b2441] border border-purple-100 dark:border-[#3c4f80] rounded-lg flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex gap-1">
              {selectedToolkit.primaryBrandColor && (
                <div
                  className="w-5 h-5 rounded-full border border-white shadow-sm"
                  style={{ backgroundColor: selectedToolkit.primaryBrandColor }}
                />
              )}
              {selectedToolkit.secondaryBrandColor && (
                <div
                  className="w-5 h-5 rounded-full border border-white shadow-sm"
                  style={{ backgroundColor: selectedToolkit.secondaryBrandColor }}
                />
              )}
            </div>
            <div>
              <p className="font-medium text-sm text-foreground dark:text-[#e6ecff]">
                {selectedToolkit.name || selectedToolkit.brandName}
              </p>
              {selectedToolkit.tagline && (
                <p className="text-xs text-muted-foreground dark:text-[#9fb0d8]">{selectedToolkit.tagline}</p>
              )}
            </div>
          </div>
          <Badge variant="outline" className="text-purple-600 dark:text-[#bca8ff] dark:border-[#6f5bb0]">Active</Badge>
        </div>
      )}
    </div>
  );
}
