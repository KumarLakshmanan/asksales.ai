import { redirectOutreachInbox } from "@/components/outreach/inbox/redirectInbox";

export default async function ChannelPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return redirectOutreachInbox("facebook", searchParams);
}
