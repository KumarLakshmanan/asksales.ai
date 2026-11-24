import { describe, expect, it } from "vitest";
import { SUPPORT_AI_READINESS_NOTICE, supportHandoffDescription, supportOwnershipLabel, supportOwnershipStage } from "../lib/supportTicketWorkspace";

describe("support ownership labels", () => {
  it("does not equate a handoff permission with actual AI readiness", () => {
    expect(supportOwnershipLabel({ handoffId: 1, handoffAssignedMemberId: 2, aiReplyEnabled: true, ownershipMode: "ai_active" }))
      .toBe("Human owned");
  });

  it("shows human ownership for a paused assigned handoff", () => {
    expect(supportOwnershipLabel({ handoffId: 1, handoffAssignedMemberId: 2, aiReplyEnabled: false, ownershipMode: "human_owned" }))
      .toBe("Human owned");
  });

  it("keeps an unassigned handoff visibly waiting for a person", () => {
    expect(supportOwnershipLabel({ handoffId: 1, handoffAssignedMemberId: null, aiReplyEnabled: true, ownershipMode: "ai_active" }))
      .toBe("Needs human");
  });

  it.each(["human_owned", "manual"])("retains %s without a handoff", (ownershipMode) => {
    expect(supportOwnershipLabel({ handoffId: null, ownershipMode })).toBe("Human owned");
  });

  it.each([true, false, undefined])("describes ownership without promising AI readiness when the ticket flag is %s", aiReplyEnabled => {
    expect(supportOwnershipLabel({ handoffId: null, ownershipMode: "ai_active", aiReplyEnabled })).toBe("No human takeover");
    expect(supportHandoffDescription({ handoffId: null, ownershipMode: 'ai_active', aiReplyEnabled })).toBe('There is no human takeover on this conversation.');
  });
  it('leaves unfamiliar ownership unverified instead of claiming AI is active', () => {
    expect(supportOwnershipLabel({ ownershipMode: 'unknown' })).toBe('Ownership unverified');
    expect(supportHandoffDescription({ ownershipMode: 'unknown' })).toContain('has not been verified');
  });
  it('explains handoff policy separately from runtime and account readiness', () => {
    expect(supportHandoffDescription({ handoffId: 1, ownershipMode: 'human_owned', aiReplyEnabled: false })).toBe('This handoff pauses AI replies.');
    expect(supportHandoffDescription({ handoffId: 1, ownershipMode: 'human_owned', aiReplyEnabled: true })).toContain('permits limited AI assistance');
    expect(SUPPORT_AI_READINESS_NOTICE).toContain('enabled runtime');
    expect(SUPPORT_AI_READINESS_NOTICE).toContain('ready, published assistant assigned to the account');
  });
});

describe('support ownership progress', () => {
  it.each(['human_owned', 'manual'])('shows an assigned %s ticket as claimed without a handoff', ownershipMode => {
    expect(supportOwnershipStage({ status: 'open', ownershipMode, assignedMemberId: 5 })).toBe('claimed');
  });
  it('shows unassigned manual work as needing a person', () => {
    expect(supportOwnershipStage({ status: 'open', ownershipMode: 'human_owned' })).toBe('requested');
  });
  it('keeps an assigned handoff human-owned during bounded AI assistance', () => {
    expect(supportOwnershipStage({ status: 'in_progress', ownershipMode: 'ai_active', handoffId: 1, handoffAssignedMemberId: 5 })).toBe('claimed');
  });
  it('does not confuse a historical assignee with active AI ownership', () => {
    expect(supportOwnershipStage({ status: 'open', ownershipMode: 'ai_active', assignedMemberId: 5 })).toBe('ai');
  });
  it.each(['resolved', 'closed'])('marks %s work complete', status => {
    expect(supportOwnershipStage({ status, ownershipMode: 'human_owned', assignedMemberId: 5 })).toBe('resolved');
  });
});
