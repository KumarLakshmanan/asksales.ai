"use client";

import { SetupField, SetupChoices, SetupTags, choiceOptions } from "./SetupFields";
import { BrandAdvancedSection } from "./BrandAdvancedSection";
import type { BrandData } from "./brandToolkitData";

const VOICE_OPTIONS = ["Professional", "Casual", "Bold", "Inspiring", "Friendly", "Authoritative", "Playful", "Empathetic"];
const VALUE_OPTIONS = ["Innovation", "Trust", "Quality", "Community", "Creativity", "Integrity", "Excellence", "Sustainability", "Transparency", "Customer-first", "Other"];
export type BrandUpdate = <K extends keyof BrandData>(key: K, value: BrandData[K]) => void;
interface StepProps { data: BrandData; update: BrandUpdate; workspaceType: string }

export function BrandIdentityStep({data, update, workspaceType}: StepProps) { return (<div className="setup-fieldset">
          <SetupField
            label={workspaceType === "individual" ? "Your name or project name" : workspaceType === "creator" ? "Creator or brand name" : "Brand name"}
            value={data.brandName}
            onChange={(v) => update("brandName", v)}
            required
            maxLength={255}
            placeholder={workspaceType === "agency" ? "Your agency or this client’s brand name" : "Your brand or company name"}
          />
          <SetupField
            label="Tagline"
            value={data.tagline}
            onChange={(v) => update("tagline", v)}
            placeholder="A short phrase that captures your brand"
          />
          <BrandAdvancedSection title="Purpose and mission" hint="Add more direction later" populated={!!data.missionStatement}>
          <SetupField
            label="Mission statement"
            value={data.missionStatement}
            onChange={(v) => update("missionStatement", v)}
            multiline
            placeholder="Why does your brand exist? What change do you want to make?"
          />
          </BrandAdvancedSection>
        </div>); }

export function BrandVoiceStep({data, update}: StepProps) {
 const toggleVoice = (trait: string) => update("voiceTraits", data.voiceTraits.includes(trait) ? data.voiceTraits.filter((item) => item !== trait) : [...data.voiceTraits, trait]);
 const toggleValue = (value: string) => update("brandValues", data.brandValues.includes(value) ? data.brandValues.filter((item) => item !== value) : [...data.brandValues, value]);
 return (<div className="setup-fieldset">
          <SetupChoices
            label="Voice personality"
            required
            hint="Choose the traits people should hear in your content."
            options={choiceOptions([...VOICE_OPTIONS, ...data.voiceTraits])}
            selected={data.voiceTraits}
            onSelect={toggleVoice}
          />
          <SetupChoices
            label="Brand values"
            options={choiceOptions([...VALUE_OPTIONS, ...data.brandValues])}
            selected={data.brandValues}
            onSelect={toggleValue}
          />
          {data.brandValues.includes("Other") && (
            <SetupField
              label="Your brand value"
              value={data.otherValue}
              onChange={(v) => update("otherValue", v)}
              required
            />
          )}
          <BrandAdvancedSection title="Detailed voice guidance" hint="Keywords, tone, and writing rules" populated={!!(data.brandKeywords || data.voiceKeywords.length || data.voiceType || data.voiceDos.length || data.voiceDonts.length || data.customToneGuidelines)}>
          <SetupField
            label="Brand keywords"
            value={data.brandKeywords}
            onChange={(v) => update("brandKeywords", v)}
            hint="Topics people associate with your brand, separated by commas."
            placeholder="Design, collaboration, growth"
          />
          <SetupTags
            label="Voice keywords"
            value={data.voiceKeywords}
            onChange={(v) => update("voiceKeywords", v)}
            hint="Words your brand likes to use, such as simplify or empower."
          />
          <SetupField
            label="Tone of voice"
            value={data.voiceType}
            onChange={(v) => update("voiceType", v)}
            placeholder="e.g. Clear, confident, and conversational"
            maxLength={100}
          />
          <div className="setup-field-row">
            <SetupTags
              label="Voice do’s"
              value={data.voiceDos}
              onChange={(v) => update("voiceDos", v)}
              hint="e.g. Use plain language"
            />
            <SetupTags
              label="Voice don’ts"
              value={data.voiceDonts}
              onChange={(v) => update("voiceDonts", v)}
              hint="e.g. Avoid jargon"
            />
          </div>
          <SetupField
            label="Tone guidelines"
            value={data.customToneGuidelines}
            onChange={(v) => update("customToneGuidelines", v)}
            multiline
            placeholder="Any other guidance on how your brand should sound?"
          />
          </BrandAdvancedSection>
        </div>); }

export function BrandContentStep({data, update, workspaceType}: StepProps) { return (<div className="setup-fieldset">
          <SetupTags
            label="Content pillars"
            value={data.contentPillars}
            onChange={(v) => update("contentPillars", v)}
            hint="The recurring topics your content should cover."
            suggestions={workspaceType === "creator" ? ["Tutorials", "Behind the scenes", "Community stories", "Creative process"] : workspaceType === "individual" ? ["My work", "Lessons learned", "Project updates"] : ["Education", "Customer stories", "Product insights", "Industry trends"]}
          />
          <SetupTags
            label="Content formats"
            value={data.contentFormats}
            onChange={(v) => update("contentFormats", v)}
            suggestions={[
              "Social posts",
              "Blog articles",
              "Email newsletters",
              "Short videos",
              "Carousels",
            ]}
          />
          <SetupTags
            label="Default hashtags"
            value={data.defaultHashtags}
            onChange={(v) => update("defaultHashtags", v)}
            hashtag
          />
          <SetupTags
            label="Calls to action"
            value={data.defaultCtas}
            onChange={(v) => update("defaultCtas", v)}
            suggestions={["Learn more", "Book a demo", "Get started"]}
          />
          <SetupField
            label="Content guidelines"
            value={data.contentInstructions}
            onChange={(v) => update("contentInstructions", v)}
            multiline
            placeholder="What should your content include or avoid?"
          />
        </div>); }

export function BrandAudienceFields({data, update}: Omit<StepProps, "workspaceType">) { return (<BrandAdvancedSection title="Audience guidance" hint="Add when you know your audience" populated={!!(data.audiencePainPoints.length || data.audienceGoals.length || data.audienceLanguageStyle.length || data.audienceTriggers.length)}><SetupTags
            label="Audience pain points"
            value={data.audiencePainPoints}
            onChange={(v) => update("audiencePainPoints", v)}
            hint="Problems your customers want to solve."
          />
          <SetupTags
            label="Audience goals"
            value={data.audienceGoals}
            onChange={(v) => update("audienceGoals", v)}
            hint="What success looks like for your customers."
          />
          <SetupTags
            label="Audience language"
            value={data.audienceLanguageStyle}
            onChange={(v) => update("audienceLanguageStyle", v)}
            hint="Words, languages, or communication styles your customers prefer."
          />
          <SetupTags
            label="Buying triggers"
            value={data.audienceTriggers}
            onChange={(v) => update("audienceTriggers", v)}
            hint="Events that make your customers look for a solution."
          /></BrandAdvancedSection>); }
