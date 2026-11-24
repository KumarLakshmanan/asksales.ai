export function metaActionValue(
  actions: Array<{ action_type?: string; value?: string }> | undefined,
  accepted: string[],
): number {
  const normalized = new Set(accepted.map((value) => value.toLowerCase()));
  return (actions || []).reduce((largest, action) => {
    const type = String(action.action_type || "")
      .toLowerCase()
      .replace(/^offsite_conversion\.fb_pixel_purchase$/, "purchase");
    const matches =
      normalized.has(type) ||
      [...normalized].some((value) => type.endsWith(`.${value}`));
    return matches ? Math.max(largest, Number(action.value) || 0) : largest;
  }, 0);
}

/** Select one objective-relevant result family so Meta's overlapping action aliases are not double-counted. */
export function metaConversionValue(
  actions: Array<{ action_type?: string; value?: string }> | undefined,
  objective?: string,
): number {
  const normalizedObjective = String(objective || "").toUpperCase();
  if (normalizedObjective.includes("LEAD")) {
    return metaActionValue(actions, [
      "lead",
      "onsite_conversion.lead_grouped",
      "offsite_lead_add_20_s_calls",
    ]);
  }
  if (normalizedObjective.includes("ENGAGEMENT"))
    return metaActionValue(actions, ["post_engagement"]);
  if (normalizedObjective.includes("MESSAG"))
    return metaActionValue(actions, ["messaging_conversation_started_7d"]);
  if (normalizedObjective.includes("SALE"))
    return metaActionValue(actions, ["purchase", "omni_purchase"]);
  if (normalizedObjective.includes("APP")) {
    return metaActionValue(actions, ["mobile_app_install", "app_install"]);
  }
  const purchases = metaActionValue(actions, ["purchase", "omni_purchase"]);
  if (purchases > 0) return purchases;
  const leads = metaActionValue(actions, [
    "lead",
    "onsite_conversion.lead_grouped",
    "offsite_lead_add_20_s_calls",
  ]);
  if (leads > 0) return leads;
  return metaActionValue(actions, ["complete_registration"]);
}
