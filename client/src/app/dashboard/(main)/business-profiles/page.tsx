import { redirect } from "next/navigation";

export default function BusinessProfilesPage() {
  redirect("/dashboard/home?workspace=choose");
}
