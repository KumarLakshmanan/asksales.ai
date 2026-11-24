"use client";

import IntegrationDetail from "@/components/admin/IntegrationDetail";
import { Video } from "lucide-react";

export default function GeminiVideoIntegrationPage() {
  return (
    <IntegrationDetail
      platform="gemini_video"
      platformName="Gemini Video"
      icon={<Video className="h-6 w-6" />}
      color="bg-violet-500"
      description="Gemini & Vertex AI key for AI video generation"
      features={["Video Generation", "Image-to-Video", "Gemini API", "Vertex AI"]}
      showSecretField
      keyFieldLabel="API Key"
      keyFieldPlaceholder="AIza..."
      secretFieldLabel="Project ID (Vertex AI only, optional)"
      secretFieldPlaceholder="my-gcp-project-id"
      showModelField
      modelPlaceholder="Select video model"
      modelOptions={[
        { value: "veo-3.1-generate-preview", label: "Veo 3.1 Preview" },
        { value: "veo-3.1-generate-001", label: "Veo 3.1 (Vertex AI)" },
        { value: "veo-2.0-generate", label: "Veo 2.0" },
      ]}
    />
  );
}
