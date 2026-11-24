"use client";
import { useParams } from "next/navigation";
import IntegrationCredentialForm from "@/components/admin/IntegrationCredentialForm";
import { PLATFORM_CONFIGS } from "@/lib/admin-integration-platforms";
const allowed = new Set(["openai", "openrouter", "gemini", "vertex_ai", "custom_ai"]);
export default function EditClassifierPage() {
  const params = useParams();
  const platform = String(params.platform || "").replaceAll("-", "_");
  const id = Number(params.id);
  if (!allowed.has(platform) || !Number.isSafeInteger(id) || id < 1) return <p>Unknown classifier credential</p>;
  return <IntegrationCredentialForm platform={platform} config={PLATFORM_CONFIGS[platform]} credentialId={id} classifier />;
}
