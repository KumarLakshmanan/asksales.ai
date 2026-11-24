export function supportMediaScanNotice(state: string, scan: Record<string, unknown> = {}): string | null {
  if (state === 'ready_for_review') {
    return 'Awaiting review: safety scans are disabled, unavailable, or incomplete. Review this image to approve or reject it, or check vision and moderation configuration and retry scans.';
  }
  if (state === 'quarantined') {
    return 'Not published: an image, privacy, or integrity safety check requires review. Replace the image with approved content; editing its name does not override the safety decision.';
  }
  if (state === 'failed') return 'Not published: scanning failed. Retry scans or replace the image.';
  if ((scan.ownerReview as { decision?: string } | undefined)?.decision === 'approve') return 'Approved by owner review. Automated scans were incomplete.';
  if (scan.scannerUnavailable === true) return 'Required safety scans have not completed.';
  return null;
}
