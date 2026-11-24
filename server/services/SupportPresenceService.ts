import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import {
  localDateKey,
  splitPresenceIntervalsByLocalDay,
  validTimezone,
} from './supportPresenceTime.js';
import { sha256Hex as fingerprint } from '../utils/sha256.js';

export const SUPPORT_PRESENCE_IDLE_MINUTES = 5;

export interface SupportCapacitySettings {
  handlingMinutesPerTicket: number;
  socialFallbackSlaMinutes: number;
  emailFallbackSlaMinutes: number;
}

export interface MemberRoutingEstimate {
  memberId: number | null;
  teamId: number | null;
  active: boolean;
  unrepliedWorkload: number;
  estimatedMinutes: number;
  fallbackUsed: boolean;
  calculatedAt: string;
}

const rows = (result: { rows?: unknown[] }) => (result.rows || []) as Array<Record<string, unknown>>;

function roundedFive(minutes: number) {
  return Math.max(5, Math.ceil(minutes / 5) * 5);
}

export class SupportPresenceService {
  async closeStaleSessions(userId?: number, database = db): Promise<void> {
    await database.execute(sql`
      UPDATE support_member_presence_sessions
      SET ended_at = last_seen_at + (${SUPPORT_PRESENCE_IDLE_MINUTES} || ' minutes')::interval,
          end_reason = 'inactivity', updated_at = NOW()
      WHERE ended_at IS NULL
        AND last_seen_at <= NOW() - (${SUPPORT_PRESENCE_IDLE_MINUTES} || ' minutes')::interval
        ${userId ? sql`AND user_id = ${userId}` : sql``}
    `);
  }

  async startOrTouch(userId: number, memberId: number, sessionJti: string): Promise<void> {
    if (!sessionJti) return;
    await this.closeStaleSessions(userId);
    const sessionFingerprint = fingerprint(sessionJti);
    await db.execute(sql`
      WITH touched AS (
        UPDATE support_member_presence_sessions
        SET last_seen_at = NOW(), updated_at = NOW()
        WHERE user_id = ${userId}
          AND member_id = ${memberId}
          AND session_fingerprint = ${sessionFingerprint}
          AND ended_at IS NULL
        RETURNING id
      )
      INSERT INTO support_member_presence_sessions (
        user_id, member_id, session_fingerprint, started_at, last_seen_at, created_at, updated_at
      )
      SELECT ${userId}, ${memberId}, ${sessionFingerprint}, NOW(), NOW(), NOW(), NOW()
      WHERE NOT EXISTS (SELECT 1 FROM touched)
      ON CONFLICT (business_profile_id, user_id, member_id, session_fingerprint) WHERE ended_at IS NULL
      DO UPDATE SET last_seen_at = NOW(), updated_at = NOW()
    `);
  }

  async end(userId: number, memberId: number, sessionJti: string, reason: 'logout' | 'revoked' | 'disabled' | 'expired' = 'logout') {
    if (!sessionJti) return;
    await db.execute(sql`
      UPDATE support_member_presence_sessions
      SET ended_at = LEAST(NOW(), last_seen_at + (${SUPPORT_PRESENCE_IDLE_MINUTES} || ' minutes')::interval),
          end_reason = ${reason}, updated_at = NOW()
      WHERE user_id = ${userId} AND member_id = ${memberId}
        AND session_fingerprint = ${fingerprint(sessionJti)} AND ended_at IS NULL
    `);
  }

  async endAllForMember(userId: number, memberId: number, reason: 'disabled' | 'revoked' = 'disabled') {
    await db.execute(sql`
      UPDATE support_member_presence_sessions
      SET ended_at = LEAST(NOW(), last_seen_at + (${SUPPORT_PRESENCE_IDLE_MINUTES} || ' minutes')::interval),
          end_reason = ${reason}, updated_at = NOW()
      WHERE user_id=${userId} AND member_id=${memberId} AND ended_at IS NULL
    `);
  }

  async getCapacitySettings(userId: number, database = db): Promise<SupportCapacitySettings> {
    const result = await database.execute(sql`
      SELECT handling_minutes_per_ticket, social_fallback_sla_minutes, email_fallback_sla_minutes
      FROM support_capacity_settings WHERE user_id = ${userId} LIMIT 1
    `);
    const row = rows(result)[0];
    return {
      handlingMinutesPerTicket: Number(row?.handling_minutes_per_ticket || 5),
      socialFallbackSlaMinutes: Number(row?.social_fallback_sla_minutes || 30),
      emailFallbackSlaMinutes: Number(row?.email_fallback_sla_minutes || 240),
    };
  }

  async saveCapacitySettings(userId: number, settings: SupportCapacitySettings): Promise<SupportCapacitySettings> {
    await db.execute(sql`
      INSERT INTO support_capacity_settings (
        user_id, handling_minutes_per_ticket, social_fallback_sla_minutes, email_fallback_sla_minutes, created_at, updated_at
      ) VALUES (
        ${userId}, ${settings.handlingMinutesPerTicket}, ${settings.socialFallbackSlaMinutes}, ${settings.emailFallbackSlaMinutes}, NOW(), NOW()
      ) ON CONFLICT (business_profile_id, user_id) DO UPDATE SET
        handling_minutes_per_ticket=EXCLUDED.handling_minutes_per_ticket,
        social_fallback_sla_minutes=EXCLUDED.social_fallback_sla_minutes,
        email_fallback_sla_minutes=EXCLUDED.email_fallback_sla_minutes,
        updated_at=NOW()
    `);
    return this.getCapacitySettings(userId);
  }

  async estimateRouting(userId: number, channel: string, requestedTeamId?: number, database = db): Promise<MemberRoutingEstimate> {
    await this.closeStaleSessions(userId, database);
    const settings = await this.getCapacitySettings(userId, database);
    const result = await database.execute(sql`
      WITH member_workload AS (
        SELECT tm.id AS member_id, tm.team_id, tm.is_on_call,
          COUNT(t.id) FILTER (
            WHERE t.status IN ('open', 'in_progress')
              AND NOT EXISTS (
                SELECT 1 FROM support_ticket_messages member_reply
                WHERE member_reply.ticket_id = t.id
                  AND member_reply.direction = 'outbound'
                  AND COALESCE(member_reply.is_internal, FALSE) = FALSE
                  AND member_reply.created_at > COALESCE((
                    SELECT MAX(customer_message.created_at)
                    FROM support_ticket_messages customer_message
                    WHERE customer_message.ticket_id = t.id
                      AND customer_message.direction = 'inbound'
                      AND COALESCE(customer_message.is_internal, FALSE) = FALSE
                  ), t.created_at)
              )
          )::int AS unreplied_count
        FROM team_members tm
        JOIN support_teams st ON st.id = tm.team_id
        JOIN support_member_presence_sessions ps
          ON ps.member_id = tm.id AND ps.user_id = tm.user_id
          AND ps.ended_at IS NULL
          AND ps.last_seen_at > NOW() - (${SUPPORT_PRESENCE_IDLE_MINUTES} || ' minutes')::interval
        LEFT JOIN support_tickets t ON t.assigned_member_id = tm.id AND t.deleted_at IS NULL
        WHERE tm.user_id = ${userId} AND st.user_id = ${userId}
          AND tm.is_active IS TRUE AND st.is_active IS TRUE
          ${requestedTeamId ? sql`AND tm.team_id = ${requestedTeamId}` : sql``}
        GROUP BY tm.id, tm.team_id, tm.is_on_call
      )
      SELECT member_id, team_id, unreplied_count
      FROM member_workload
      ORDER BY unreplied_count ASC, is_on_call DESC, member_id ASC
      LIMIT 1
    `);
    const candidate = rows(result)[0];
    const fallbackMinutes = channel === 'email'
      ? settings.emailFallbackSlaMinutes
      : settings.socialFallbackSlaMinutes;
    if (!candidate) {
      return {
        memberId: null, teamId: requestedTeamId || null, active: false, unrepliedWorkload: 0,
        estimatedMinutes: roundedFive(fallbackMinutes), fallbackUsed: true, calculatedAt: new Date().toISOString(),
      };
    }
    const workload = Number(candidate.unreplied_count || 0);
    return {
      memberId: Number(candidate.member_id), teamId: Number(candidate.team_id), active: true,
      unrepliedWorkload: workload,
      estimatedMinutes: roundedFive((workload + 1) * settings.handlingMinutesPerTicket),
      fallbackUsed: false, calculatedAt: new Date().toISOString(),
    };
  }

  async listTeamSummaries(userId: number, teamId: number) {
    await this.closeStaleSessions(userId);
    const settings = await this.getCapacitySettings(userId);
    const result = await db.execute(sql`
      SELECT tm.id AS member_id,
        MAX(ps.last_seen_at) AS last_seen_at,
        BOOL_OR(ps.ended_at IS NULL AND ps.last_seen_at > NOW() - (${SUPPORT_PRESENCE_IDLE_MINUTES} || ' minutes')::interval) AS active,
        COUNT(DISTINCT t.id) FILTER (
          WHERE t.status IN ('open', 'in_progress')
            AND NOT EXISTS (
              SELECT 1 FROM support_ticket_messages member_reply
              WHERE member_reply.ticket_id=t.id AND member_reply.direction='outbound'
                AND COALESCE(member_reply.is_internal,FALSE)=FALSE
                AND member_reply.created_at > COALESCE((
                  SELECT MAX(customer_message.created_at) FROM support_ticket_messages customer_message
                  WHERE customer_message.ticket_id=t.id AND customer_message.direction='inbound'
                    AND COALESCE(customer_message.is_internal,FALSE)=FALSE
                ), t.created_at)
            )
        )::int AS unreplied_count
      FROM team_members tm
      LEFT JOIN support_member_presence_sessions ps ON ps.member_id=tm.id AND ps.user_id=tm.user_id
      LEFT JOIN support_tickets t ON t.assigned_member_id=tm.id AND t.deleted_at IS NULL
      WHERE tm.user_id=${userId} AND tm.team_id=${teamId}
      GROUP BY tm.id ORDER BY tm.id
    `);
    return rows(result).map((row) => {
      const workload = Number(row.unreplied_count || 0);
      return {
        memberId: Number(row.member_id), presenceState: row.active === true ? 'active' : 'away',
        lastSeenAt: row.last_seen_at || null, unrepliedWorkload: workload,
        projectedResponseMinutes: roundedFive((workload + 1) * settings.handlingMinutesPerTicket),
      };
    });
  }

  async getMemberActivity(userId: number, memberId: number, from: Date, to: Date) {
    await this.closeStaleSessions(userId);
    const memberResult = await db.execute(sql`
      SELECT tm.timezone
      FROM team_members tm
      JOIN support_teams st ON st.id=tm.team_id AND st.user_id=tm.user_id
      WHERE tm.user_id=${userId} AND tm.id=${memberId}
      LIMIT 1
    `);
    const timezone = validTimezone(String(rows(memberResult)[0]?.timezone || 'Asia/Kolkata'));
    const result = await db.execute(sql`
      SELECT ps.id, ps.started_at, ps.last_seen_at,
        COALESCE(ps.ended_at, LEAST(NOW(), ps.last_seen_at + (${SUPPORT_PRESENCE_IDLE_MINUTES} || ' minutes')::interval)) AS ended_at,
        ps.end_reason
      FROM support_member_presence_sessions ps
      JOIN team_members tm ON tm.id=ps.member_id AND tm.user_id=ps.user_id
      JOIN support_teams st ON st.id=tm.team_id AND st.user_id=ps.user_id
      WHERE ps.user_id=${userId} AND ps.member_id=${memberId}
        AND ps.started_at < ${to} AND COALESCE(ps.ended_at, ps.last_seen_at + (${SUPPORT_PRESENCE_IDLE_MINUTES} || ' minutes')::interval) >= ${from}
      ORDER BY ps.started_at ASC
    `);
    const intervals = rows(result).map((row) => ({
      id: Number(row.id), startedAt: new Date(String(row.started_at)).toISOString(),
      lastSeenAt: new Date(String(row.last_seen_at)).toISOString(),
      endedAt: new Date(String(row.ended_at)).toISOString(), endReason: row.end_reason || null,
    }));
    const daily = splitPresenceIntervalsByLocalDay(intervals, timezone);
    const replyResult = await db.execute(sql`
      SELECT created_at FROM support_ticket_messages
      WHERE member_id=${memberId} AND user_id=${userId} AND direction='outbound'
        AND COALESCE(is_internal,FALSE)=FALSE AND created_at >= ${from} AND created_at < ${to}
    `);
    for (const row of rows(replyResult)) {
      const createdAt = new Date(String(row.created_at));
      const date = localDateKey(createdAt, timezone);
      const item = daily.get(date) || { date, activeMinutes: 0, firstLogin: createdAt.toISOString(), lastActive: createdAt.toISOString(), intervals: [], replies: 0 };
      item.replies += 1;
      daily.set(date, item);
    }
    const workload = await db.execute(sql`
      SELECT COUNT(*)::int AS count FROM support_tickets t
      WHERE t.user_id=${userId} AND t.assigned_member_id=${memberId} AND t.deleted_at IS NULL
        AND t.status IN ('open','in_progress')
        AND NOT EXISTS (
          SELECT 1 FROM support_ticket_messages member_reply
          WHERE member_reply.ticket_id=t.id AND member_reply.direction='outbound'
            AND COALESCE(member_reply.is_internal,FALSE)=FALSE
            AND member_reply.created_at > COALESCE((
              SELECT MAX(customer_message.created_at) FROM support_ticket_messages customer_message
              WHERE customer_message.ticket_id=t.id AND customer_message.direction='inbound'
                AND COALESCE(customer_message.is_internal,FALSE)=FALSE
            ), t.created_at)
        )
    `);
    const now = new Date();
    const today = daily.get(localDateKey(now, timezone));
    const freshCutoff = now.getTime() - SUPPORT_PRESENCE_IDLE_MINUTES * 60_000;
    const activeSessions = intervals.filter((item) => !item.endReason && Date.parse(item.lastSeenAt) > freshCutoff).length;
    return {
      memberId, timezone,
      presenceState: activeSessions > 0 ? 'active' : 'away',
      lastActivity: intervals.reduce<string | null>((latest, item) => !latest || item.lastSeenAt > latest ? item.lastSeenAt : latest, null),
      todayActiveMinutes: today?.activeMinutes || 0,
      todayFirstLogin: today?.intervals[0]?.startedAt || null,
      activeSessions,
      unrepliedWorkload: Number(rows(workload)[0]?.count || 0),
      daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    };
  }
}

export const supportPresenceService = new SupportPresenceService();
