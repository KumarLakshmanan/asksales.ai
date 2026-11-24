"use client";

import { useId, useState } from "react";
import type { BrandData } from "./brandToolkitData";
import "./brand-toolkit.css";

const FORMATS = ["Social post", "Email", "Headline"] as const;
type Format = typeof FORMATS[number];

export function brandSample(data: Pick<BrandData, "brandName" | "tagline" | "voiceTraits" | "contentPillars" | "defaultCtas" | "defaultHashtags">, format: Format) {
  const name = data.brandName.trim() || "Your brand";
  const topic = data.contentPillars[0]?.trim() || "what matters to you";
  const bold = data.voiceTraits.some((trait) => ["Bold", "Authoritative"].includes(trait));
  const playful = data.voiceTraits.some((trait) => ["Playful", "Casual"].includes(trait));
  const friendly = data.voiceTraits.some((trait) => ["Friendly", "Empathetic"].includes(trait));
  const headline = data.tagline.trim() || (bold ? `Move forward with ${name}.` : playful ? `Meet your next good idea: ${name}.` : `${name}, here to help.`);
  const introduction = bold ? `Take the next step in ${topic}.` : playful ? `Let’s talk ${topic} — and make it happen.` : friendly ? `Looking for a little help with ${topic}? We’re here for you.` : `Explore a practical approach to ${topic} with ${name}.`;
  const cta = data.defaultCtas[0]?.trim() || "Learn more";
  if (format === "Headline") return { headline, body: introduction, cta };
  if (format === "Email") return { headline: `A note from ${name}`, body: `${friendly || playful ? "Hi there," : "Hello,"}\n\n${introduction}\n\n${headline}\n\n${friendly ? "Thanks for being here." : "Explore what comes next."}`, cta };
  return { headline: name, body: `${headline}\n\n${introduction}${data.defaultHashtags.length ? `\n\n${data.defaultHashtags.slice(0, 4).join(" ")}` : ""}`, cta };
}

/** Returns WCAG relative contrast for two six-digit hex colors. */
export function brandColorContrast(first: string, second: string): number | null {
  const luminance = (hex: string) => {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return null;
    const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255).map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const one = luminance(first); const two = luminance(second);
  return one === null || two === null ? null : (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}

export function BrandContentPreview({ data }: { data: BrandData }) {
  const [format, setFormat] = useState<Format>("Social post");
  const id = useId();
  const sample = brandSample(data, format);
  const contrast = brandColorContrast(data.primaryColor, "#ffffff");
  const labelColor = contrast !== null && contrast >= 4.5 ? "#ffffff" : "#000000";
  const color = /^#[0-9a-f]{6}$/i.test(data.primaryColor) ? data.primaryColor : "#6d28d9";
  return (
    <section className="brand-content-preview" aria-label="Live brand preview">
      <div className="brand-preview-heading">
        <div><h3>Live brand preview</h3><p>Illustrative copy using your selected voice and visual choices.</p></div>
        <div role="group" aria-label="Preview format" className="brand-preview-formats">
          {FORMATS.map((item) => <button type="button" key={item} aria-pressed={format === item} aria-controls={id} onClick={() => setFormat(item)}>{item}</button>)}
        </div>
      </div>
      <div id={id} className="brand-preview-paper" style={{ borderTopColor: color }}>
        <span className="brand-preview-eyebrow">{format}</span>
        <h4 style={{ fontFamily: data.fonts.heading || undefined }}>{sample.headline}</h4>
        <p style={{ fontFamily: data.fonts.body || undefined }}>{sample.body}</p>
        <span className="brand-preview-cta" style={{ background: color, color: labelColor }}>{sample.cta}</span>
      </div>
      <p className="brand-preview-note">Voice: {data.voiceTraits.join(", ") || "Choose voice traits to shape the sample"}. Samples do not publish content.</p>
      {contrast !== null && contrast < 4.5 && <p className="brand-preview-note">White text on this primary color has {contrast.toFixed(1)}:1 contrast. The preview uses dark text; choose a darker shade if you plan to use white body text.</p>}
    </section>
  );
}
