import { ApiError } from "@/lib/api";

/**
 * Plain-language reason shown when the campaign history list fails to load.
 * Keeps the failure visible and tells the user what to do next; never shows raw server text.
 */
export function campaignHistoryFailureReason(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Your session may have expired. Sign in again, then try again.";
    }
    if (error.status === 404) {
      return "The selected business profile was not found. Choose a profile in the workspace switcher, then try again.";
    }
    if (error.status === 400) {
      return "The selected business profile could not be used for this request. Reload the page and try again.";
    }
    if (error.status !== undefined && error.status >= 500) {
      return `The server could not read your campaign history (error ${error.status}). Try again in a moment; if it keeps failing, contact support.`;
    }
  }
  if (error instanceof TypeError) {
    return "The request did not reach the server. Check your connection and try again.";
  }
  return "Something went wrong while loading your campaigns. Try again.";
}
