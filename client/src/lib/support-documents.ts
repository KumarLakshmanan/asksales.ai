export const DOCUMENT_TOPICS = [
  ['resort', 'Resort details'], ['stay', 'Rooms and stays'], ['corporate', 'Corporate events'],
  ['celebration', 'Weddings and celebrations'], ['spa', 'Spa'], ['dining', 'Dining and menus'],
  ['day_outing', 'Day outings'], ['activities', 'Activities'], ['location', 'Location'],
  ['technical_support', 'Technical support'], ['sales', 'Sales'], ['general', 'General information'], ['other', 'Other'],
] as const;
export type SupportLibraryDocument = {
  id: number; title: string; description: string; service: string; businessProfileId: number | null;
  storageFileId: number; checksum: string; status: 'draft' | 'published' | 'withdrawn';
  revision: number; approvalId: number | null; updatedAt: string; expiresAt: string | null;
};
export const documentTopicLabel = (service: string) => DOCUMENT_TOPICS.find(item => item[0] === service)?.[1] || service;
export function documentIsAvailable(document: SupportLibraryDocument) {
  return document.status === 'published' && (!document.expiresAt || new Date(document.expiresAt).getTime() > Date.now());
}
