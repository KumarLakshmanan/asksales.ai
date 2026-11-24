import { redirect } from "next/navigation";

export default function LegacyBusinessProfilesPage() {
  redirect("/dashboard/home?workspace=choose");
}
