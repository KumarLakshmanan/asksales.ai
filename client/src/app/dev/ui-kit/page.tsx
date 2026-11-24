import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { UiKitGallery } from "./UiKitGallery";

export const metadata: Metadata = {
  title: "UI kit",
  robots: { index: false, follow: false },
};

/** Living usage examples for the shared UI components. Development builds only. */
export default function UiKitPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <UiKitGallery />;
}
