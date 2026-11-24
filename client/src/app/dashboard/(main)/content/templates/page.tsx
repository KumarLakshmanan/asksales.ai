import { redirect } from "next/navigation";

export default function ContentTemplatesRedirect() {
  redirect("/dashboard/saved-templates");
}
