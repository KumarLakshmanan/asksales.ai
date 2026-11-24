import { redirectOutreachCreation } from "@/components/outreach/create/redirectCreation";

export default async function CreatePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return redirectOutreachCreation("instagram", searchParams);
}
