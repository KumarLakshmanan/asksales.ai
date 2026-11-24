import type { Message } from "@/models/message";

export interface ConversationActionButton {
  id: string;
  action?: string;
  data?: Record<string, unknown>;
}

export type ConversationActionResolution =
  | { status: "pending" }
  | { status: "processing"; selectedButtonId: string; action?: string; outcome?: "selected" | "approved" | "rejected" }
  | { status: "selected"; selectedButtonId: string; action?: string; outcome?: "selected" | "approved" | "rejected" }
  | { status: "failed_retryable"; selectedButtonId: string; action?: string; outcome?: "selected" | "approved" | "rejected"; failure?: string }
  | { status: "superseded" };

/** Prefer the result of the latest action request over stale message metadata.
 * A durable superseded decision still retires the control immediately. */
export function resolveDisplayedConversationAction(
  persisted: ConversationActionResolution,
  override?: ConversationActionResolution,
): ConversationActionResolution {
  if (persisted.status === "superseded") return persisted;
  return override ?? persisted;
}

const normalizeReply = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
const approvalActions = new Set(['APPROVE_ICP', 'LEAD_AGENT_APPROVE', 'approve_tool', 'reject_tool']);

export function isOneShotConversationAction(button: ConversationActionButton): boolean {
  const configuredReply = button.data?.message;
  const reusableNavigationAction = /^(?:OPEN_|VIEW_|EDIT_|SELECT_|CREATE_BRAND_TOOLKIT|EXPORT_?)/i.test(button.action || "");

  return (
    (!reusableNavigationAction && typeof configuredReply === "string" && configuredReply.trim().length > 0) ||
    button.action?.startsWith("HIRE_") === true ||
    button.action === "LEAD_AGENT_APPROVE" ||
    button.action === "APPROVE_ICP" ||
    button.action === "approve_tool" ||
    button.action === "reject_tool"
  );
}

function matchesRecordedReply(button: ConversationActionButton, reply: string): boolean {
  // Approval status comes from a durable receipt, never words like "yes" or
  // "do not" in an unrelated follow-up question.
  if (approvalActions.has(button.action || '')) return false;
  const configuredReply = button.data?.message;
  if (typeof configuredReply === "string" && normalizeReply(configuredReply) === reply) {
    return true;
  }

  return false;
}

export function resolveConversationAction(
  message: Pick<Message, "metadata">,
  laterMessages: ReadonlyArray<Pick<Message, "role" | "content"> & Partial<Pick<Message, "metadata">>>,
): ConversationActionResolution {
  const persistedResolution = message.metadata?.actionResolution;
  const pending = message.metadata?.pendingApproval;
  const reviewButtons = Array.isArray(message.metadata?.actionButtons)
    ? message.metadata.actionButtons as ConversationActionButton[] : [];
  for (const candidate of laterMessages) {
    const cancelled = candidate.metadata?.cancelledApproval;
    if (!cancelled?.requestId || !cancelled?.toolName) continue;
    const matchingButtons = reviewButtons.filter(button =>
      ['approve_tool', 'reject_tool', 'LEAD_AGENT_APPROVE'].includes(button.action || '') &&
      (button.data?.requestId || pending?.executionId || pending?.toolCallId) === cancelled.requestId &&
      (button.data?.toolName || pending?.toolName) === cancelled.toolName,
    );
    if (matchingButtons.length) {
      const rejection = matchingButtons.find(button => button.action === 'reject_tool');
      return rejection ? { status: 'selected', selectedButtonId: rejection.id, action: 'reject_tool', outcome: 'rejected' } : { status: 'superseded' };
    }
  }
  if (persistedResolution?.status !== 'selected') {
    const hasNewerBoundReview = reviewButtons.some(button => {
      if (!approvalActions.has(button.action || '') || button.action === 'APPROVE_ICP') return false;
      const requestId = button.data?.requestId || pending?.executionId || pending?.toolCallId;
      const toolName = button.data?.toolName || pending?.toolName;
      if (!requestId || !toolName) return false;
      return laterMessages.some(candidate => Array.isArray(candidate.metadata?.actionButtons) &&
        (candidate.metadata.actionButtons as ConversationActionButton[]).some(laterButton =>
          approvalActions.has(laterButton.action || '') &&
          (laterButton.data?.requestId || candidate.metadata?.pendingApproval?.executionId || candidate.metadata?.pendingApproval?.toolCallId) === requestId &&
          (laterButton.data?.toolName || candidate.metadata?.pendingApproval?.toolName) === toolName,
        ));
    });
    if (hasNewerBoundReview) return { status: 'superseded' };
  }
  // Retire superseded resource-bound review controls, including failed retries.
  // This compares saved identities/revisions, never guesses approval from prose.
  const icpButton = Array.isArray(message.metadata?.actionButtons)
    ? (message.metadata.actionButtons as ConversationActionButton[]).find(button => button.action === 'APPROVE_ICP')
    : undefined;
  if (icpButton && persistedResolution?.status !== 'selected') {
    const hasNewerReview = laterMessages.some(candidate =>
      Array.isArray(candidate.metadata?.actionButtons) &&
      (candidate.metadata.actionButtons as ConversationActionButton[]).some(button =>
        button.action === 'APPROVE_ICP' &&
        (icpButton.data?.icpId == null || button.data?.icpId === icpButton.data.icpId) &&
        Number(button.data?.revision ?? 0) >= Number(icpButton.data?.revision ?? 0),
      ),
    );
    if (hasNewerReview) return { status: 'superseded' };
  }
  if (persistedResolution && typeof persistedResolution === "object" && !Array.isArray(persistedResolution)) {
    const persisted = persistedResolution as Record<string, unknown>;
    const status = persisted.status;
    const selectedButtonId = persisted.selectedButtonId;
    if (
      (status === "processing" || status === "selected" || status === "failed_retryable")
      && typeof selectedButtonId === "string"
    ) {
      return {
        status,
        selectedButtonId,
        ...(typeof persisted.action === "string" ? { action: persisted.action } : {}),
        ...(persisted.outcome === "selected" || persisted.outcome === "approved" || persisted.outcome === "rejected"
          ? { outcome: persisted.outcome }
          : {}),
        ...(status === "failed_retryable" && typeof persisted.failure === "string"
          ? { failure: persisted.failure }
          : {}),
      } as ConversationActionResolution;
    }
    if (status === "superseded") return { status: "superseded" };
  }

  const rawButtons = message.metadata?.actionButtons;
  if (!Array.isArray(rawButtons) || rawButtons.length === 0) {
    return { status: "pending" };
  }

  const buttons = rawButtons.filter(
    (button): button is ConversationActionButton =>
      Boolean(button) && typeof button === "object" && typeof button.id === "string",
  );
  const oneShotButtons = buttons.filter(isOneShotConversationAction);
  if (oneShotButtons.length === 0) {
    return { status: "pending" };
  }

  const nextUserReply = laterMessages.find(
    (candidate) => candidate.role === "user" && candidate.content.trim().length > 0,
  );
  if (!nextUserReply) {
    return { status: "pending" };
  }

  const normalizedReply = normalizeReply(nextUserReply.content);
  const selectedButton = oneShotButtons.find((button) => matchesRecordedReply(button, normalizedReply));
  if (selectedButton) {
    return { status: "selected", selectedButtonId: selectedButton.id };
  }

  // A later user turn closes a prompt made entirely of one-shot choices. It must
  // not remain clickable because the conversation has already moved past it.
  if (oneShotButtons.length === buttons.length && !buttons.some(button => approvalActions.has(button.action || ''))) {
    return { status: "superseded" };
  }

  return { status: "pending" };
}
