"use client";

import { use } from "react";
import SmtpCredentialForm from "@/components/admin/SmtpCredentialForm";

export default function SmtpEditCredentialPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <SmtpCredentialForm credentialId={Number(id)} />;
}
