"use client";
import { GenerationEstimate } from './GenerationEstimate';

export type CompanionMedia = { image: boolean; video: boolean };
export function CompanionMediaOptions({ value, onChange, copies = 1 }: { value: CompanionMedia; onChange: (value: CompanionMedia) => void; copies?: number }) {
  return <fieldset className="space-y-2 rounded-lg border border-border p-3 text-sm">
    <legend className="px-1 text-xs font-medium">Include generated media</legend>
    <label className="flex items-center gap-2"><input type="checkbox" checked={value.image} onChange={(e) => onChange({ ...value, image: e.target.checked })} />Generate one image</label>
    <label className="flex items-center gap-2"><input type="checkbox" checked={value.video} onChange={(e) => onChange({ ...value, video: e.target.checked })} />Generate one video</label>
    <p className="text-xs text-muted-foreground">{!value.image && !value.video ? "Copy only. No image or video job will start." : "Selected media runs in the background and incurs additional provider usage charges. Unselected media will not be generated."}</p>
    {copies > 1 && <p className="text-xs text-muted-foreground">Each selected platform creates a separate draft and its own selected media.</p>}
    <GenerationEstimate image={value.image} video={value.video} copies={copies} />
  </fieldset>;
}
