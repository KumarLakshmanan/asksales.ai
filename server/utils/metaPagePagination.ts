interface PageBatch<T> { data?: T[]; paging?: { next?: string }; error?: { message?: string } }
/** Load the complete consent inventory before replacing any saved accounts. */
export async function collectMetaPages<T extends { id: string }>(first: PageBatch<T>, token: string): Promise<T[]> {
  const pages = new Map<string, T>();
  const visited = new Set<string>();
  let batch = first;
  for (let count = 0; count < 100; count++) {
    if (batch.error) throw new Error('Meta Page discovery failed. Reconnect and try again.');
    for (const page of batch.data || []) pages.set(page.id, page);
    if (!batch.paging?.next) return [...pages.values()];
    const url = new URL(batch.paging.next);
    if (url.protocol !== 'https:' || url.hostname !== 'graph.facebook.com' || visited.has(url.href)) {
      throw new Error('Meta returned an invalid Page pagination link.');
    }
    visited.add(url.href);
    url.searchParams.delete('access_token');
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Meta Page discovery could not complete.');
    batch = await response.json() as PageBatch<T>;
  }
  throw new Error('Meta Page discovery exceeded the pagination limit.');
}
