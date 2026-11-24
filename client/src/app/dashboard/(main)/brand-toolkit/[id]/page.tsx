"use client";

import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { useRouter, useParams } from "next/navigation";
import { BrandToolkitForm } from "@/components/BrandToolkitForm";
import { PageErrorState } from "@/components/ui/page-state";
import { confirmUnsavedNavigation } from "@/hooks/use-unsaved-changes";

export default function BrandToolkitFormPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const isCreateMode = params?.id === "new";
  const parsedToolkitId = !isCreateMode ? Number(params?.id) : undefined;
  const toolkitId = parsedToolkitId && Number.isSafeInteger(parsedToolkitId) && parsedToolkitId > 0
    ? parsedToolkitId
    : undefined;

  if (!isCreateMode && !toolkitId) {
    return (
      <PageErrorState
        title="Invalid brand toolkit"
        description="This brand toolkit link is not valid. Return to the toolkit list and choose an existing brand."
        reset={() => router.replace("/dashboard/brand-toolkit")}
      />
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-6 px-4 py-5 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button aria-label="Back to brand toolkits" variant="ghost" size="icon" onClick={() => { if (confirmUnsavedNavigation()) router.push("/dashboard/brand-toolkit"); }}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            {!isCreateMode ? "Edit Brand Toolkit" : "Create Brand Toolkit"}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {!isCreateMode
              ? "Update your brand guidelines and assets"
              : "Set up your brand guidelines for consistent content creation"}
          </p>
        </div>
      </div>

      <BrandToolkitForm
        toolkitId={toolkitId}
        isCreateMode={isCreateMode}
        saveButtonLabel={!isCreateMode ? "Update Toolkit" : "Create Toolkit"}
        onSaveSuccess={() => router.push("/dashboard/brand-toolkit")}
      />
    </div>
  );
}
