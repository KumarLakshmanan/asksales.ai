export interface CrmMutationResult {
  automationReviewRequired?: boolean;
  refreshRequired?: boolean;
}
export function contactSavedToast(
  result: CrmMutationResult,
  title = "Contact updated",
) {
  if (result.automationReviewRequired)
    return {
      title: "Contact saved; automation needs attention",
      description:
        "Open the contact’s Automation recovery section to check the saved transition and safely retry pending evaluation.",
    };
  if (result.refreshRequired)
    return {
      title: "Contact saved; refresh needed",
      description:
        "Reload the contact to see its latest state before editing again.",
    };
  return { title };
}
