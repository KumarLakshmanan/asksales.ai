import api from "@/lib/api";

interface TemplatePage<T> { templates: T[]; total: number }

/** Request pagination explicitly: the legacy array response is capped at 200. */
export async function loadReusableTemplates<T extends { id: number }>(type: string): Promise<T[]> {
  const templates: T[] = [];
  const seen = new Set<number>();
  let offset = 0;
  while (true) {
    const query = new URLSearchParams({ type, limit: "200", offset: String(offset) });
    const response = await api.get<T[] | TemplatePage<T>>(`/api/content/templates?${query}`);
    const page = Array.isArray(response) ? response : response.templates;
    if (!Array.isArray(page)) throw new Error("Saved templates could not be loaded. Try again.");
    page.forEach((template) => { if (!seen.has(template.id)) { seen.add(template.id); templates.push(template); } });
    offset += page.length;
    if (Array.isArray(response) || !page.length || !Number.isSafeInteger(response.total) || offset >= response.total) return templates;
  }
}
