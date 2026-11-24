/**
 * Provider developer controls are intentionally hidden from normal workspace
 * users. They can be re-enabled for a controlled local/admin session without
 * changing the production UI contract.
 */
export const providerDeveloperToolsEnabled = process.env.NEXT_PUBLIC_ENABLE_PROVIDER_DEV_TOOLS === "true";
