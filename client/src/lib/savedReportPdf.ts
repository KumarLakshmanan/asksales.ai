import { aiVisibilityApi } from './ai-visibility';
import { getAuthHeaders } from './authHeaders';
import { fetchWithReadRetry } from "./api-client";

const previewFailure = 'The PDF preview could not be loaded.';

function responseFailure(status: number) {
  const guidance: Record<number, string> = {
    401: 'Please sign in again, then retry.',
    403: 'You do not have permission to read this report. Check the selected workspace or ask its owner for access.',
    404: 'The saved PDF is unavailable. Retry, or ask the workspace owner to check this report.',
    409: 'The saved PDF is not ready. Refresh the report status, then retry.',
    502: 'The saved PDF could not be delivered. Retry, or ask the workspace owner to check this report.',
  };
  return new Error(`${previewFailure} ${guidance[status] || 'Please try again later.'} (HTTP ${status})`);
}

export async function fetchSavedReportPdf(auditId: number, signal?: AbortSignal): Promise<Blob> {
  let response: Response;
  try {
    response = await fetchWithReadRetry(aiVisibilityApi.reportUrl(auditId), {
      credentials: 'include',
      headers: getAuthHeaders(),
      signal,
    });
  } catch (error) {
    // Query cancellation belongs to the departing view, not a failed PDF read.
    if (signal?.aborted) throw error;
    throw new Error(`${previewFailure} Check your connection and retry.`);
  }
  signal?.throwIfAborted();
  if (!response.ok) throw responseFailure(response.status);
  const mime = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  if (mime !== 'application/pdf') {
    throw new Error(`${previewFailure} The server did not return a valid PDF. Retry, or ask the workspace owner to check this report.`);
  }
  let blob: Blob;
  let signature: string;
  // This guards empty/mislabeled responses. It is not a PDF parser or proof
  // that the native viewer can render every page of a structurally valid file.
  try {
    blob = await response.blob();
    signature = await blob.slice(0, 5).text();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`${previewFailure} The file transfer was interrupted. Check your connection and retry.`);
  }
  signal?.throwIfAborted();
  if (signature !== '%PDF-') {
    throw new Error(`${previewFailure} The saved file is not a valid PDF. Ask the workspace owner to check this report.`);
  }
  return blob;
}
