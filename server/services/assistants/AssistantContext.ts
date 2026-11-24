import { AsyncLocalStorage } from "node:async_hooks";
import { currentBusinessScope } from "../../tenancy/businessContext.js";
import type {
  AssistantDraft,
  AssistantProvenance,
} from "../../../shared/outreachAssistants.js";

export interface ResolvedAssistant {
  provenance: AssistantProvenance;
  configuration: AssistantDraft;
  preview: boolean;
}
export function freezeAssistant<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeAssistant);
    Object.freeze(value);
  }
  return value;
}
const context = new AsyncLocalStorage<ResolvedAssistant | undefined>();
const deliveryMarkers = new AsyncLocalStorage<Record<string, unknown>>();
/** null means an explicitly global rollout; an invalid allowlist enables nobody. */
export function assistantRolloutProfiles(): number[] | null {
  const configured = (
    process.env.SUPPORT_ASSISTANTS_BUSINESS_PROFILES || ""
  ).trim();
  if (!configured) return null;
  const parts = configured.split(",").map((v) => v.trim());
  if (
    parts.some(
      (v) =>
        !/^\d+$/.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) <= 0,
    )
  )
    return [];
  return [...new Set(parts.map(Number))];
}
export function assistantsRuntimeEnabled(): boolean {
  if (process.env.SUPPORT_ASSISTANTS_ENABLED !== "true") return false;
  const profiles = assistantRolloutProfiles();
  return (
    profiles === null ||
    profiles.includes(currentBusinessScope()?.businessProfileId || 0)
  );
}
export function currentAssistant(): ResolvedAssistant | undefined {
  return context.getStore();
}
/** Campaign email processing must not inherit a surrounding support persona. */
export function withoutAssistantContext<T>(work: () => T): T {
  return context.run(undefined, () => deliveryMarkers.run({}, work));
}
export function withAssistantContext<T>(
  assistant: ResolvedAssistant | undefined,
  work: () => T,
): T {
  return assistant
    ? context.run(assistant, () => deliveryMarkers.run({}, work))
    : work();
}
export function markAssistantDelivery(markers: Record<string, unknown>): void {
  Object.assign(deliveryMarkers.getStore() || {}, markers);
}
export function assistantDeliveryMetadata(): Record<string, unknown> {
  const assistant = currentAssistant();
  return assistant && !assistant.preview
    ? {
        assistant: assistant.provenance,
        providerAccountId: assistant.provenance.accountId,
        ...deliveryMarkers.getStore(),
      }
    : {};
}
/** Deliberate None and empty allowlists never mean all business resources. */
export function assistantResourceIds(
  kind: "knowledge" | "documents" | "galleries",
): readonly number[] | undefined {
  const selection = currentAssistant()?.configuration[kind];
  return selection
    ? selection.mode === "selected"
      ? selection.ids
      : []
    : undefined;
}
