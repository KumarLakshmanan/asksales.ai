"use client";

import Image from "next/image";

export function WhatsAppMediaPreview({ components, uploadedPreview }: { components?: unknown; uploadedPreview?: string }) {
  if (!Array.isArray(components)) return null;
  const header = components.find((component) => component?.type === "header");
  const parameter = header?.parameters?.[0];
  const type = parameter?.type;
  const link = parameter?.[type]?.id && uploadedPreview?.startsWith('blob:')
    ? uploadedPreview : parameter?.[type]?.link;
  if (typeof link !== "string" || !/^(https:\/\/\S+|blob:.+)$/i.test(link)) return parameter?.[type]?.id
    ? <p className="mb-4 text-xs text-muted-foreground">Uploaded template {type} is saved. A preview is available only in the browser that uploaded it.</p> : null;
  if (type === "image")
    return (
      <Image
        unoptimized
        src={link}
        alt="WhatsApp template header"
        width={640}
        height={360}
        className="mb-4 max-h-60 w-full rounded-md border object-contain"
      />
    );
  if (type === "video")
    return (
      <a
        href={link}
        target="_blank"
        rel="noreferrer noopener"
        className="mb-4 block break-all text-sm text-primary hover:underline"
      >
        Preview template video
      </a>
    );
  if (type === "document")
    return (
      <a
        href={link}
        target="_blank"
        rel="noreferrer noopener"
        className="mb-4 block break-all text-sm text-primary hover:underline"
      >
        Preview template document
      </a>
    );
  return null;
}
