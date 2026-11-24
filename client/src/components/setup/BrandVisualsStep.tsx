"use client";

import type { ChangeEvent } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { buildApiUrl } from "@/lib/api";
import { SetupField } from "./SetupFields";
import { BrandContentPreview } from "./BrandContentPreview";
import { BrandAdvancedSection } from "./BrandAdvancedSection";
import type { BrandData } from "./brandToolkitData";
import type { BrandUpdate } from "./BrandToolkitSteps";

export function BrandVisualsStep({ data, update, handleLogoUpload, uploadingLogo, failedLogoUrl, setFailedLogoUrl }: {
  data: BrandData;
  update: BrandUpdate;
  handleLogoUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  uploadingLogo: boolean;
  failedLogoUrl: string;
  setFailedLogoUrl: (url: string) => void;
}) { return (<div className="setup-fieldset">
          <div className="setup-field-row">
            {(["primaryColor", "secondaryColor", "accentColor"] as const).map(
              (key, i) => (
                <div className="setup-field" key={key}>
                  <label htmlFor={`color-${key}`}>
                    {["Primary color *", "Secondary color", "Accent color"][i]}
                  </label>
                  <div className="setup-color-row">
                    <input
                      type="color"
                      value={
                        /^#[0-9a-fA-F]{6}$/.test(data[key])
                          ? data[key]
                          : "#ffffff"
                      }
                      aria-label={`${["Primary", "Secondary", "Accent"][i]} color picker`}
                      onChange={(e) => update(key, e.target.value)}
                    />
                    <Input
                      id={`color-${key}`}
                      value={data[key]}
                      onChange={(e) => update(key, e.target.value)}
                      maxLength={7}
                      placeholder="#514BBB"
                    />
                  </div>
                </div>
              ),
            )}
          </div>
          {data.colorPalette.length > 0 && (
            <div className="setup-field">
              <label>Additional brand colors</label>
              <div className="flex flex-wrap gap-3">
                {[...new Set(data.colorPalette)].map((color) => (
                  <button
                    type="button"
                    key={color}
                    onClick={() => update("primaryColor", color)}
                    className="flex items-center gap-2 rounded-lg border px-3 py-2 text-xs"
                    aria-label={`Use ${color} as primary color`}
                  >
                    <span
                      className="h-5 w-5 rounded"
                      style={{ backgroundColor: color }}
                    />
                    {color}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="setup-field-row">
            <SetupField
              label="Heading font"
              value={data.fonts.heading}
              onChange={(v) => update("fonts", { ...data.fonts, heading: v })}
              placeholder="e.g. Manrope"
              maxLength={100}
            />
            <SetupField
              label="Body font"
              value={data.fonts.body}
              onChange={(v) => update("fonts", { ...data.fonts, body: v })}
              placeholder="e.g. Source Sans 3"
              maxLength={100}
            />
          </div>
          <SetupField
            label="Accent font"
            value={data.fonts.accent}
            onChange={(v) => update("fonts", { ...data.fonts, accent: v })}
            placeholder="Optional font for short accents"
            maxLength={100}
          />
          {data.fontFamilies.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Detected on your website: {data.fontFamilies.join(", ")}
            </p>
          )}
          <BrandContentPreview data={data} />
          <div className="setup-field">
            <label htmlFor="setup-logo">Brand logo</label>
            <p>PNG, JPG, or WebP, up to 5 MB.</p>
            <input
              id="setup-logo"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={handleLogoUpload}
              disabled={uploadingLogo}
              className="text-sm"
            />
            {uploadingLogo && <p role="status">Uploading logo…</p>}
            {data.logoUrl && (
              <div className="flex items-center gap-4 rounded-lg border p-4">
                {failedLogoUrl === data.logoUrl ? (
                  <p role="status">
                    Logo preview unavailable. Upload a replacement.
                  </p>
                ) : (
                  <img
                    src={buildApiUrl(data.logoUrl)}
                    alt="Your brand logo"
                    className="h-16 w-24 object-contain"
                    onError={() => setFailedLogoUrl(data.logoUrl)}
                  />
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => update("logoUrl", "")}
                >
                  Remove logo
                </Button>
              </div>
            )}
          </div>
          <BrandAdvancedSection title="Detailed visual guidance" hint="Image style and logo rules" populated={!!(data.imageStyleReference || data.visualInstructions || data.logoUsageGuidelines)}>
          <SetupField
            label="Image style"
            value={data.imageStyleReference}
            onChange={(v) => update("imageStyleReference", v)}
            placeholder="e.g. Natural photography or clean illustrations"
            maxLength={100}
          />
          <SetupField
            label="Visual guidelines"
            value={data.visualInstructions}
            onChange={(v) => update("visualInstructions", v)}
            multiline
            placeholder="Describe composition, imagery, and visual details to follow."
          />
          <SetupField
            label="Logo usage guidelines"
            value={data.logoUsageGuidelines}
            onChange={(v) => update("logoUsageGuidelines", v)}
            multiline
            placeholder="Where and how should your logo appear?"
          />
          </BrandAdvancedSection>
        </div>); }
