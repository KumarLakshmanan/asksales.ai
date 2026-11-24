import { redirect } from "next/navigation";
import type { InboxChannel } from "../../../../../shared/outreachInbox";

export async function redirectOutreachCreation(
  channel: InboxChannel,
  searchParams: Promise<Record<string, string | string[] | undefined>>,
) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach((item) => query.append(key, item));
    else if (value !== undefined) query.set(key, value);
  }
  query.set("channel", channel);
  redirect(`/dashboard/outreach/create?${query}`);
}
