import { redirect } from "next/navigation";

// Password changes live on the account settings Security tab. Redirect on the
// server so the old link never shows a blank page first.
export default function ChangePasswordPage() {
  redirect("/dashboard/settings?tab=security");
}
