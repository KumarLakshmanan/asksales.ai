import { redirect } from "next/navigation";

/** Existing settings can be imported and reviewed from the Assistants page. */
export default function LegacySpecialistEditorRedirect() {
  redirect("/dashboard/settings/outreach");
}
