"use client";
import { useParams } from "next/navigation";
import IntegrationCredentialForm from "@/components/admin/IntegrationCredentialForm";
import { PLATFORM_CONFIGS } from "@/lib/admin-integration-platforms";
const allowed = new Set(["openai", "openrouter", "gemini", "vertex_ai", "custom_ai"]);
export default function AddClassifierPage() {
  const params = useParams();
  const platform = String(params.platform || "").replaceAll("-", "_");
  if (!allowed.has(platform)) return <p>Unknown classifier provider</p>;
  return <IntegrationCredentialForm platform={platform} config={PLATFORM_CONFIGS[platform]} classifier />;
}
