/** Shared by the ICP specialist and its structured-generation service. */
export const ICP_CHANNEL_SELECTION_POLICY = `CHANNEL SELECTION PRIORITY:
- An explicit user-selected platform or workflow is the complete channel scope. Use only those requested channels; do not append inferred channels from business type, geography, website content, or an older profile.
- Respect exclusions and "only" restrictions. Mentioning a platform to exclude it is not a selection. Resolve add/remove requests against the existing list and return the complete final list.
- Infer channels only when the user has not selected any and there is no existing selection to preserve. Defaults are suggestions, never mandatory additions: B2B professionals -> ["linkedin"]; local businesses in India -> ["google_maps", "justdial"]; local businesses outside India -> ["google_maps"]; consumer brands -> ["instagram", "facebook"].
- Examples: "cafes in Coimbatore using only Google Maps Business Search" -> ["google_maps"]; "cafes using JustDial" -> ["justdial"]; "use LinkedIn and Google Maps, not JustDial" -> ["linkedin", "google_maps"].
- Yelp is unsupported. Do not include it in new or revised channel selections; explain that it is unavailable if requested.
- Unrelated ICP edits must preserve the previously selected channels.`;
