import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { requireBusinessScope } from '../tenancy/businessContext.js';

export interface ResourceMember { id: number; userId: number; teamId: number }
export interface MemberResourceScope { ticketId: number | null; businessProfileId: number | null; source: 'workspace' | 'ticket' }
export class MemberResourceScopeError extends Error {
  constructor(message: string, public status: 400 | 403) { super(message); }
}

/** Ticket context can narrow a member's library scope. It never borrows the owner's default property. */
export async function resolveSupportMemberResourceScope(member: ResourceMember, ticketId?: unknown): Promise<MemberResourceScope> {
  if (ticketId == null || ticketId === '') return { ticketId: null, businessProfileId: requireBusinessScope().businessProfileId, source: 'workspace' };
  const parsed = typeof ticketId === 'string' && /^[1-9]\d*$/.test(ticketId) ? Number(ticketId) : ticketId;
  if (!Number.isSafeInteger(parsed) || Number(parsed) <= 0) throw new MemberResourceScopeError('Choose a valid support ticket.', 400);
  const result = await db.execute(sql`
    SELECT t.id, t.business_profile_id FROM support_tickets t
    JOIN team_members m ON m.id=${member.id} AND m.user_id=t.user_id AND m.is_active=TRUE
    JOIN support_teams team ON team.id=m.team_id AND team.user_id=m.user_id AND team.is_active=TRUE
    LEFT JOIN outreach_conversations c ON c.id=t.outreach_conversation_id AND c.user_id=t.user_id
    WHERE t.id=${Number(parsed)} AND t.user_id=${member.userId} AND m.team_id=${member.teamId}
      AND t.deleted_at IS NULL AND (t.assigned_member_id=m.id OR t.team_id=m.team_id) LIMIT 1
  `);
  const row = result.rows[0] as { id: number; business_profile_id?: number | null } | undefined;
  if (!row) throw new MemberResourceScopeError('This ticket is not available to your support team.', 403);
  return { ticketId: Number(row.id), businessProfileId: row.business_profile_id ? Number(row.business_profile_id) : null, source: 'ticket' };
}
