/** Server-attested clock/zone for an approved rendering. Preserve it with send provenance. */
export interface TemplateRenderContext {
  version: 1;
  renderedAt: string;
  timeZone: string;
  signature: string;
}
