"use client";

/**
 * SourceImagePicker
 * Reusable image upload/select component for source images in transforms.
 */

import React, { useRef } from "react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Upload, X } from "lucide-react";

interface SourceImagePickerProps {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  label?: string;
}

export function SourceImagePicker({ value, onChange, label = 'Source Image' }: SourceImagePickerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // In a real implementation, this would upload to the server
      // For now, we'll use a local preview URL
      const url = URL.createObjectURL(file);
      onChange(url);
    }
  };

  const handleRemove = () => {
    onChange(undefined);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileSelect}
        className="hidden"
      />

      {value ? (
        <div className="relative rounded-lg border overflow-hidden">
          <img
            src={value}
            alt="Source"
            className="w-full h-32 object-cover"
          />
          <Button
            variant="destructive"
            size="icon"
            className="absolute top-2 right-2 h-6 w-6"
            onClick={handleRemove}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex h-32 w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed bg-secondary/30 transition-colors hover:border-primary/40 hover:bg-secondary/50"
        >
          <Upload className="h-6 w-6 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Click to upload</span>
        </button>
      )}
    </div>
  );
}
