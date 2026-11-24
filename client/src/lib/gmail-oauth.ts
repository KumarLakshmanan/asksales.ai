const CALLBACK_ERRORS: Record<string, string> = {
  access_denied: "Google authorization was cancelled. Choose Connect Gmail to try again.",
  invalid_or_expired_state: "This Gmail connection session expired. Choose Connect Gmail to start again.",
  session_changed: "Your sign-in session changed. Return to the business you want to connect and start again.",
  permission_changed: "Your permission to connect this business changed. Ask its owner or billing admin for help.",
  oauth_unavailable: "Gmail sign-in is temporarily unavailable. Try again shortly.",
  configuration_changed: "Gmail sign-in settings changed during authorization. Choose Connect Gmail to start again.",
  no_config: "Gmail sign-in needs to be configured by the app administrator before you can connect.",
  missing_code: "Google did not complete authorization. Choose Connect Gmail to try again.",
  missing_scopes: "Gmail needs the requested email permissions. Connect again and allow those permissions in Google.",
  missing_refresh_token: "Google did not grant ongoing Gmail access. Connect again and complete the Google consent steps.",
  token_exchange_failed: "Google authorization could not be completed. Choose Connect Gmail to try again.",
  connection_failed: "Gmail could not be connected. Choose Connect Gmail to try again.",
  mailbox_already_connected: "This Gmail mailbox has a conflicting connection. Ask an administrator to review existing connections before reconnecting.",
  authorization_code_rejected: "Google rejected the authorization code because it expired, was already used, or no longer matches this sign-in. Choose Connect Gmail to start a fresh authorization.",
  oauth_client_rejected: "Google rejected the app’s OAuth client credentials. Ask the app administrator to check the Gmail client ID and secret.",
  redirect_uri_mismatch: "The Gmail callback address does not match the address registered with Google. Ask the app administrator to check the OAuth redirect URI.",
  gmail_api_disabled: "The Gmail API is disabled for this app’s Google Cloud project. Ask the app administrator to enable it before reconnecting.",
  workspace_policy_blocked: "Your Google Workspace administrator blocks this app’s Gmail access. Ask them to allow the app before reconnecting.",
  mailbox_unavailable: "Google reports that this account’s Gmail mailbox is unavailable. Check that Gmail is enabled for the account before reconnecting.",
  google_rate_limited: "Google temporarily limited this app’s Gmail requests or quota. Wait a few minutes before reconnecting. If it continues, ask the app administrator to check Google API quotas.",
  google_connection_unavailable: "The server could not reach Google. Try connecting again shortly. If it continues, ask the app administrator to check the server’s network connection to Google.",
  google_unavailable: "Google returned a service error. Try connecting again shortly.",
  google_access_rejected: "Google rejected Gmail access for this authorization. Choose Connect Gmail and complete a fresh authorization.",
  google_access_blocked: "Google denied the app access to this Gmail account. Check the requested permissions and your Google Workspace app access policy before reconnecting.",
  connection_storage_failed: "Google authorization completed, but the app could not save the connection. Ask the app administrator to check the database using the reference below.",
  connection_database_permission_denied: "The database denied the app permission to save the Gmail connection. Ask the app administrator to check database permissions and business access policies.",
  connection_database_schema_outdated: "The app’s database is missing a required Gmail connection field or function. Ask the app administrator to apply the required database migrations.",
  connection_database_conflict: "A saved connection record conflicts with this Gmail connection. Ask the app administrator to review duplicate records using the reference below.",
  connection_database_unavailable: "The app could not reach its database while setting up Gmail. Try again shortly. If it continues, ask the app administrator to check database availability.",
  credential_save_failed: "The app could not save the Gmail credentials. Ask the app administrator to check credential encryption and database access using the reference below.",
  sender_setup_failed: "Gmail credentials were saved, but sender setup could not finish. Check the connection status below and share the reference with the app administrator.",
  mailbox_profile_failed: "The app could not read your Gmail mailbox identity. Check that Gmail is enabled and that you allowed email access, then reconnect.",
  permissions_failed: "The app could not verify the Gmail permissions granted by Google. Connect again and allow the requested email permissions.",
  configuration_failed: "The app could not load its Gmail sign-in settings. Ask the app administrator to check the OAuth configuration and credential encryption.",
  connection_capacity_exceeded: "This business has reached its email connection limit. Ask its owner to review the plan’s connection allowance before reconnecting.",
};

const CALLBACK_STAGES: Record<string, string> = {
  session: "Checking the sign-in session",
  configuration: "Loading Gmail sign-in settings",
  token_exchange: "Completing Google authorization",
  permissions: "Verifying Gmail permissions",
  mailbox_profile: "Reading the Gmail mailbox identity",
  credential_save: "Saving Gmail credentials",
  sender_setup: "Setting up the Gmail sender",
};

export function gmailCallbackFailure(code: string, stage: string | null, reference: string | null) {
  return {
    code: Object.hasOwn(CALLBACK_ERRORS, code) ? code : "connection_failed",
    message: gmailCallbackErrorMessage(code),
    stage: stage && Object.hasOwn(CALLBACK_STAGES, stage) ? CALLBACK_STAGES[stage] : null,
    reference: reference && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(reference) ? reference : null,
  };
}

export function gmailCallbackErrorMessage(code: string): string {
  return Object.hasOwn(CALLBACK_ERRORS, code)
    ? CALLBACK_ERRORS[code]
    : "Gmail could not be connected. Choose Connect Gmail to try again.";
}

/** Only the Google authorization endpoint may receive the browser redirect. */
export function gmailAuthorizationUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid Gmail authorization URL");
  const url = new URL(value);
  if (url.origin !== "https://accounts.google.com"
    || url.pathname !== "/o/oauth2/v2/auth"
    || url.username || url.password || url.hash) {
    throw new Error("Invalid Gmail authorization URL");
  }
  return url.href;
}

export function gmailSignedInAccount(): number | null {
  try {
    const user = JSON.parse(localStorage.getItem("user") || "null");
    const id = user?.id ?? user?.user?.id;
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch { return null; }
}
