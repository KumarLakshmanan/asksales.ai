import { redirect } from "next/navigation";

export default function LegacyCompanyProfilePage() {
  redirect("/dashboard/home?workspace=choose");
}
