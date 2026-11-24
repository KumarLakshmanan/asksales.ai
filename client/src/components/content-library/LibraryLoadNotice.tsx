import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";

export function LibraryLoadNotice({ templatesError, assetsError, onRetry }: { templatesError: boolean; assetsError: boolean; onRetry: () => void }) {
  if (!templatesError && !assetsError) return null;
  return <Callout tone="danger" className="mb-4" actions={<Button type="button" variant="outline" size="sm" onClick={onRetry}>Retry missing content</Button>}>
    {templatesError ? "Some reusable templates could not be loaded." : "Saved drafts could not be loaded."} Available content is shown below.
  </Callout>;
}
