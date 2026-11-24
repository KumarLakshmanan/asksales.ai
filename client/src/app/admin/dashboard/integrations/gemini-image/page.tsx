"use client";

import IntegrationDetail from "@/components/admin/IntegrationDetail";
import { Image as ImageIcon } from "lucide-react";

export default function GeminiImageIntegrationPage() {
  return (
    <IntegrationDetail
      platform="gemini_image"
      platformName="Gemini Image"
      icon={<ImageIcon className="h-6 w-6" />}
      color="bg-indigo-500"
      description="Gemini & Vertex AI key for AI image generation"
      features={["Image Generation", "Image-to-Image", "Gemini API", "Vertex AI"]}
      showSecretField
      keyFieldLabel="API Key"
      keyFieldPlaceholder="AIza..."
      secretFieldLabel="Project ID (Vertex AI only, optional)"
      secretFieldPlaceholder="my-gcp-project-id"
      showModelField
      modelPlaceholder="Select image model"
      modelOptions={[
        { value: "gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image" },
        { value: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
        { value: "gemini-3-pro-image-preview", label: "Gemini 3 Pro Image Preview (Vertex AI)" },
        { value: "imagen-3.0-generate-002", label: "Imagen 3.0 (Vertex AI)" },
        { value: "imagen-3.0-fast-generate-001", label: "Imagen 3.0 Fast (Vertex AI)" },
      ]}
    />
  );
}
