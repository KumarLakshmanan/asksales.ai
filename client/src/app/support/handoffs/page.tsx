import { redirect } from "next/navigation";

export default function LegacySupportHandoffsPage() {
  redirect("/support/tickets?handoff=active");
}
