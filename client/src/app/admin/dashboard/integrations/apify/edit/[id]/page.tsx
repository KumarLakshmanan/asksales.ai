"use client";

import { use } from "react";
import ApifyCredentialForm from "@/components/admin/ApifyCredentialForm";

export default function ApifyEditCredentialPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <ApifyCredentialForm credentialId={Number(id)} />;
}
