"use client";

import { Button } from "@/components/ui/button";
import { SetupReview } from "./SetupShell";
import type { BrandData } from "./brandToolkitData";
import { BrandContentPreview } from "./BrandContentPreview";
import "./brand-toolkit.css";

interface ReviewSection { title: string; step: number; required?: string[]; values: Record<string, string> }
export function brandReviewSections(data: BrandData, business: Record<string, string>): ReviewSection[] {
  const join = (items: string[]) => [...new Set(items.filter(Boolean))].join(", ");
  return [
    { title: "Identity", step: 1, required: ["Brand"], values: { Brand: data.brandName, Tagline: data.tagline, Mission: data.missionStatement } },
    { title: "Voice", step: 2, required: ["Voice"], values: { Voice: join(data.voiceTraits), Values: join([...data.brandValues.filter((item) => item !== "Other"), ...(data.brandValues.includes("Other") ? [data.otherValue] : [])]), "Brand keywords": data.brandKeywords, "Voice keywords": join(data.voiceKeywords), Tone: data.voiceType, "Voice do’s": join(data.voiceDos), "Voice don’ts": join(data.voiceDonts), "Tone guidelines": data.customToneGuidelines } },
    { title: "Visuals", step: 3, required: ["Colors"], values: { Colors: join([data.primaryColor, data.secondaryColor, data.accentColor, ...data.colorPalette]), Fonts: join(Object.values(data.fonts)), Logo: data.logoUrl ? "Added" : "", "Image style": data.imageStyleReference, "Visual guidelines": data.visualInstructions, "Logo guidelines": data.logoUsageGuidelines } },
    { title: "Images", step: 4, values: { "Brand images": data.imageAssets.length ? `${data.imageAssets.length} selected` : "", "Website screenshot": data.websiteScreenshotUrl ? "Included" : "" } },
    { title: "Content", step: 5, values: { "Content pillars": join(data.contentPillars), Formats: join(data.contentFormats), Hashtags: join(data.defaultHashtags), "Calls to action": join(data.defaultCtas), "Content guidelines": data.contentInstructions } },
    { title: "Business and audience", step: 6, values: { ...business, "Audience pain points": join(data.audiencePainPoints), "Audience goals": join(data.audienceGoals), "Audience language": join(data.audienceLanguageStyle), "Buying triggers": join(data.audienceTriggers) } },
  ];
}

export function BrandReview({ data, business, onEdit }: { data: BrandData; business: Record<string, string>; onEdit: (step: number) => void }) {
  return <div className="brand-review-sections">
    {brandReviewSections(data, business).map((section) => {
      const populated = Object.fromEntries(Object.entries(section.values).filter(([key, value]) => value.trim() || section.required?.includes(key)));
      const omitted = Object.keys(section.values).filter((key) => !section.values[key].trim() && !section.required?.includes(key));
      return <section key={section.title} className="brand-review-section" aria-label={`${section.title} review`}>
        <div className="brand-review-heading"><h3>{section.title}</h3><Button type="button" variant="outline" size="sm" onClick={() => onEdit(section.step)} aria-label={`Edit ${section.title.toLowerCase()}`}>Edit</Button></div>
        {Object.keys(populated).length ? <SetupReview values={populated} /> : <p className="brand-review-empty">You can add this optional guidance now or later in your brand toolkit.</p>}
        {omitted.length > 0 && <details className="brand-review-omitted"><summary>{omitted.length} optional {omitted.length === 1 ? "field" : "fields"} not added</summary><p>{omitted.join(" · ")}</p></details>}
      </section>;
    })}
    <BrandContentPreview data={data} />
  </div>;
}
