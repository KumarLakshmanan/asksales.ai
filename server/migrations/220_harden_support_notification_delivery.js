/**
 * Durable support notification v2.
 *
 * Ticket, message, assignment, lifecycle, and handoff triggers are the
 * transactional outbox boundary. Runtime workers expand these tenant-scoped
 * events into receipts and provider deliveries after commit.
 */

const EVENT_TYPES = [
  'ticket_created_unassigned',
  'ticket_assigned',
  'ticket_reassigned',
  'human_handoff',
  'customer_replied',
  'ticket_reopened',
  'sla_at_risk',
  'sla_breached',
  'approval_required',
  'delivery_failed',
  'ticket_resolved',
];

// Instagram/Facebook remain valid only for preserving historical rows. The v2
// runtime and UI do not offer them until provider-scoped enrollment exists.
const CHANNELS = ['email', 'whatsapp', 'slack', 'teams', 'browser_push', 'instagram', 'facebook'];

export async function up(client) {
  await client.query(`
    ALTER TABLE team_members
      ADD COLUMN IF NOT EXISTS is_on_call BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS locale VARCHAR(24) NOT NULL DEFAULT 'en-IN',
      ADD COLUMN IF NOT EXISTS timezone VARCHAR(100) NOT NULL DEFAULT 'Asia/Kolkata',
      ADD COLUMN IF NOT EXISTS quiet_hours JSONB NOT NULL DEFAULT '{}'::jsonb
  `);

  await client.query(`
    ALTER TABLE notifications
      ADD COLUMN IF NOT EXISTS event_key VARCHAR(220)
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS notifications_user_event_key_uq
      ON notifications(user_id, event_key)
      WHERE event_key IS NOT NULL
  `);

  await client.query(`
    ALTER TABLE support_notification_events
      DROP CONSTRAINT IF EXISTS support_notification_events_event_type_check
  `);
  await client.query(`
    ALTER TABLE support_notification_events
      ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES support_teams(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS severity VARCHAR(20) NOT NULL DEFAULT 'normal',
      ADD COLUMN IF NOT EXISTS source_channel VARCHAR(40),
      ADD COLUMN IF NOT EXISTS category VARCHAR(80),
      ADD COLUMN IF NOT EXISTS safe_summary VARCHAR(1000) NOT NULL DEFAULT 'Support attention is required.',
      ADD COLUMN IF NOT EXISTS required_action VARCHAR(500) NOT NULL DEFAULT 'Review and respond in the support portal.',
      ADD COLUMN IF NOT EXISTS sla_deadline TIMESTAMP,
      ADD COLUMN IF NOT EXISTS processing_status VARCHAR(24) NOT NULL DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS processing_attempts INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMP NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS processing_error TEXT,
      ADD COLUMN IF NOT EXISTS expanded_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP NOT NULL DEFAULT (NOW() + INTERVAL '90 days')
  `);
  await client.query(`
    UPDATE support_notification_events
    SET event_type = CASE event_type
      WHEN 'new_ticket_assignment' THEN 'ticket_assigned'
      ELSE event_type
    END,
    processing_status = CASE WHEN event_type IN ('new_ticket_assignment', 'human_handoff') THEN 'expanded' ELSE processing_status END,
    expanded_at = COALESCE(expanded_at, created_at)
  `);
  await client.query(`
    ALTER TABLE support_notification_events
      ADD CONSTRAINT support_notification_events_event_type_check
        CHECK (event_type IN (${EVENT_TYPES.map((value) => `'${value}'`).join(', ')})),
      ADD CONSTRAINT support_notification_events_severity_check
        CHECK (severity IN ('info', 'normal', 'high', 'urgent')),
      ADD CONSTRAINT support_notification_events_processing_status_check
        CHECK (processing_status IN ('pending', 'processing', 'expanded', 'retry', 'failed'))
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS support_notification_events_outbox_idx
      ON support_notification_events(processing_status, next_attempt_at, created_at)
      WHERE processing_status IN ('pending', 'retry', 'processing')
  `);

  await client.query(`
    ALTER TABLE support_notification_receipts
      ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS escalation_level INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMP
  `);
  await client.query(`
    UPDATE support_notification_receipts r
    SET user_id = e.user_id
    FROM support_notification_events e
    WHERE e.id = r.event_id AND r.user_id IS NULL
  `);
  await client.query(`ALTER TABLE support_notification_receipts ALTER COLUMN user_id SET NOT NULL`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS support_notification_receipts_ack_idx
      ON support_notification_receipts(user_id, acknowledged_at, created_at DESC)
      WHERE acknowledged_at IS NULL
  `);

  await client.query(`
    ALTER TABLE support_notification_destinations
      DROP CONSTRAINT IF EXISTS support_notification_destinations_channel_check
  `);
  await client.query(`
    ALTER TABLE support_notification_destinations
      ADD COLUMN IF NOT EXISTS fingerprint_version SMALLINT NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS provider_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS last_tested_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS last_test_status VARCHAR(24),
      ADD CONSTRAINT support_notification_destinations_channel_check
        CHECK (channel IN (${CHANNELS.map((value) => `'${value}'`).join(', ')}))
  `);

  await client.query(`
    ALTER TABLE support_notification_preferences
      DROP CONSTRAINT IF EXISTS support_notification_preferences_event_type_check,
      DROP CONSTRAINT IF EXISTS support_notification_preferences_channel_check
  `);
  await client.query(`
    UPDATE support_notification_preferences
    SET event_type = 'ticket_assigned'
    WHERE event_type = 'new_ticket_assignment'
  `);
  await client.query(`
    ALTER TABLE support_notification_preferences
      ADD CONSTRAINT support_notification_preferences_event_type_check
        CHECK (event_type IN (${EVENT_TYPES.map((value) => `'${value}'`).join(', ')})),
      ADD CONSTRAINT support_notification_preferences_channel_check
        CHECK (channel IN (${CHANNELS.map((value) => `'${value}'`).join(', ')}))
  `);

  await client.query(`
    ALTER TABLE support_member_notification_deliveries
      DROP CONSTRAINT IF EXISTS support_member_notification_deliveries_event_type_check,
      DROP CONSTRAINT IF EXISTS support_member_notification_deliveries_channel_check,
      DROP CONSTRAINT IF EXISTS support_member_notification_deliveries_status_check
  `);
  await client.query(`
    UPDATE support_member_notification_deliveries
    SET event_type = CASE WHEN event_type IN ('ticket_created', 'new_ticket_assignment') THEN 'ticket_assigned' ELSE event_type END,
        status = CASE WHEN status = 'sent' THEN 'accepted' ELSE status END
    WHERE event_type IN ('ticket_created', 'new_ticket_assignment') OR status = 'sent'
  `);
  await client.query(`
    ALTER TABLE support_member_notification_deliveries
      ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS read_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
      ADD CONSTRAINT support_member_notification_deliveries_event_type_check
        CHECK (event_type IN (${EVENT_TYPES.map((value) => `'${value}'`).join(', ')})),
      ADD CONSTRAINT support_member_notification_deliveries_channel_check
        CHECK (channel IN (${CHANNELS.map((value) => `'${value}'`).join(', ')})),
      ADD CONSTRAINT support_member_notification_deliveries_status_check
        CHECK (status IN (
          'pending', 'sending', 'retry', 'accepted', 'delivered', 'read',
          'failed', 'uncertain', 'cancelled', 'suppressed', 'dead_letter'
        ))
  `);

  await client.query(`
    ALTER TABLE support_notification_audit_logs
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP NOT NULL DEFAULT (NOW() + INTERVAL '365 days')
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS support_notification_templates (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      team_id INTEGER REFERENCES support_teams(id) ON DELETE CASCADE,
      event_type VARCHAR(40) NOT NULL,
      channel VARCHAR(24) NOT NULL,
      locale VARCHAR(24) NOT NULL DEFAULT 'en-IN',
      audience VARCHAR(20) NOT NULL DEFAULT 'member',
      name VARCHAR(160) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      active_version INTEGER,
      managed_key VARCHAR(160),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT support_notification_templates_status_ck CHECK (status IN ('draft', 'published', 'archived')),
      CONSTRAINT support_notification_templates_event_ck CHECK (event_type IN (${EVENT_TYPES.map((value) => `'${value}'`).join(', ')})),
      CONSTRAINT support_notification_templates_channel_ck CHECK (channel IN (${CHANNELS.map((value) => `'${value}'`).join(', ')})),
      CONSTRAINT support_notification_templates_audience_ck CHECK (audience IN ('owner', 'member', 'team')),
      UNIQUE(user_id, team_id, event_type, channel, locale, audience)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS support_notification_template_versions (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      template_id BIGINT NOT NULL REFERENCES support_notification_templates(id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK (version > 0),
      subject_template VARCHAR(500),
      text_template TEXT NOT NULL,
      html_template TEXT,
      allowed_variables TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      checksum VARCHAR(64) NOT NULL,
      published_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(template_id, version)
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS support_notification_templates_scope_uq
    ON support_notification_templates(user_id, team_id, event_type, channel, locale, audience) NULLS NOT DISTINCT
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS support_notification_policies (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      team_id INTEGER NOT NULL REFERENCES support_teams(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      unassigned_strategy VARCHAR(24) NOT NULL DEFAULT 'leads_then_members',
      urgent_escalation_minutes INTEGER NOT NULL DEFAULT 10 CHECK (urgent_escalation_minutes BETWEEN 1 AND 1440),
      channels JSONB NOT NULL DEFAULT '{"in_app":true,"email":true,"browser_push":true}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, team_id)
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS support_notification_escalations (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_id BIGINT NOT NULL REFERENCES support_notification_events(id) ON DELETE CASCADE,
      receipt_id BIGINT REFERENCES support_notification_receipts(id) ON DELETE SET NULL,
      escalation_level INTEGER NOT NULL,
      reason VARCHAR(120) NOT NULL,
      recipient_member_id INTEGER REFERENCES team_members(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(event_id, escalation_level, recipient_member_id)
    )
  `);

  // The event triggers are SECURITY DEFINER so ticket mutations remain atomic
  // even when the runtime role is subject to notification-table RLS.
  await client.query(`
    CREATE OR REPLACE FUNCTION resolve_support_ticket_team()
    RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    BEGIN
      IF NEW.team_id IS NULL THEN
        SELECT id INTO NEW.team_id FROM support_teams
        WHERE user_id = NEW.user_id AND is_active IS TRUE
        ORDER BY created_at, id LIMIT 1;
      END IF;
      RETURN NEW;
    END; $$
  `);
  await client.query(`
    DROP TRIGGER IF EXISTS support_ticket_team_resolution_trg ON support_tickets;
    CREATE TRIGGER support_ticket_team_resolution_trg BEFORE INSERT ON support_tickets
      FOR EACH ROW EXECUTE FUNCTION resolve_support_ticket_team()
  `);
  await client.query(`
    CREATE OR REPLACE FUNCTION enqueue_support_ticket_notification_event()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
    DECLARE
      next_event_type TEXT;
      next_key TEXT;
      next_summary TEXT;
      next_action TEXT;
      next_severity TEXT;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.category = 'ai_handoff' THEN RETURN NEW; END IF;
        next_event_type := CASE WHEN NEW.assigned_member_id IS NULL THEN 'ticket_created_unassigned' ELSE 'ticket_assigned' END;
        next_key := 'ticket-created:' || NEW.id;
        next_summary := CASE
          WHEN NEW.category = 'hotel_sales' THEN 'A hotel sales request needs support attention.'
          ELSE 'A new support request needs attention.'
        END;
        next_action := CASE WHEN NEW.assigned_member_id IS NULL
          THEN 'Claim or assign this ticket in the support portal.'
          ELSE 'Review and respond in the support portal.' END;
      ELSIF OLD.assigned_member_id IS DISTINCT FROM NEW.assigned_member_id AND NEW.assigned_member_id IS NOT NULL THEN
        next_event_type := CASE WHEN OLD.assigned_member_id IS NULL THEN 'ticket_assigned' ELSE 'ticket_reassigned' END;
        next_key := 'ticket-assignment:' || NEW.id || ':' || NEW.assigned_member_id || ':' || floor(extract(epoch from NEW.updated_at) * 1000)::bigint;
        next_summary := 'A support ticket was assigned to a team member.';
        next_action := 'Review and respond in the support portal.';
      ELSIF OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('resolved', 'closed') THEN
        next_event_type := 'ticket_resolved';
        next_key := 'ticket-resolved:' || NEW.id || ':' || NEW.status || ':' || floor(extract(epoch from NEW.updated_at) * 1000)::bigint;
        next_summary := 'A support ticket was resolved.';
        next_action := 'No action is required unless the customer replies.';
      ELSIF OLD.status IN ('resolved', 'closed', 'waiting_on_customer') AND NEW.status IN ('open', 'in_progress') THEN
        next_event_type := 'ticket_reopened';
        next_key := 'ticket-reopened:' || NEW.id || ':' || floor(extract(epoch from NEW.updated_at) * 1000)::bigint;
        next_summary := 'A support ticket became active again.';
        next_action := 'Review the latest activity and respond.';
      ELSE
        RETURN NEW;
      END IF;

      next_severity := CASE
        WHEN NEW.priority IN ('urgent', 'critical') THEN 'urgent'
        WHEN NEW.priority = 'high' THEN 'high'
        ELSE 'normal'
      END;
      INSERT INTO support_notification_events (
        user_id, ticket_id, event_type, event_key, assigned_member_id, team_id,
        payload, severity, category, safe_summary, required_action, sla_deadline,
        processing_status
      ) VALUES (
        NEW.user_id, NEW.id, next_event_type, next_key, NEW.assigned_member_id, NEW.team_id,
        jsonb_build_object(
          'ticketId', NEW.id,
          'ticketNumber', NEW.ticket_number,
          'priority', NEW.priority,
          'ticketPath', '/support/tickets/' || NEW.id,
          'previousAssignedMemberId', CASE WHEN TG_OP='UPDATE' THEN OLD.assigned_member_id ELSE NULL END
        ), next_severity, NEW.category, next_summary, next_action, NEW.sla_deadline, 'pending'
      ) ON CONFLICT (user_id, event_key) DO NOTHING;
      RETURN NEW;
    END;
    $$
  `);
  await client.query(`
    DROP TRIGGER IF EXISTS support_ticket_notification_event_trg ON support_tickets;
    CREATE TRIGGER support_ticket_notification_event_trg
      AFTER INSERT OR UPDATE OF assigned_member_id, status ON support_tickets
      FOR EACH ROW EXECUTE FUNCTION enqueue_support_ticket_notification_event()
  `);

  // Repair active routing without generating a historical notification flood;
  // the event trigger does not fire for a team_id-only update.
  await client.query(`
    UPDATE support_tickets t SET team_id = (
      SELECT st.id FROM support_teams st WHERE st.user_id = t.user_id AND st.is_active IS TRUE
      ORDER BY st.created_at, st.id LIMIT 1
    ), updated_at = NOW()
    WHERE t.team_id IS NULL AND t.deleted_at IS NULL AND t.status IN ('open','in_progress','waiting_on_customer')
      AND EXISTS (SELECT 1 FROM support_teams st WHERE st.user_id=t.user_id AND st.is_active IS TRUE)
  `);

  await client.query(`
    CREATE OR REPLACE FUNCTION enqueue_support_customer_reply_event()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
    DECLARE ticket RECORD;
    BEGIN
      IF NEW.direction <> 'inbound' OR NEW.is_internal IS TRUE THEN RETURN NEW; END IF;
      SELECT * INTO ticket FROM support_tickets WHERE id = NEW.ticket_id AND deleted_at IS NULL;
      IF NOT FOUND THEN RETURN NEW; END IF;
      INSERT INTO support_notification_events (
        user_id, ticket_id, event_type, event_key, assigned_member_id, team_id,
        payload, severity, source_channel, category, safe_summary, required_action,
        sla_deadline, processing_status
      ) VALUES (
        ticket.user_id, ticket.id, 'customer_replied', 'customer-replied:' || ticket.id || ':' || NEW.id,
        ticket.assigned_member_id, ticket.team_id,
        jsonb_build_object(
          'ticketId', ticket.id,
          'ticketNumber', ticket.ticket_number,
          'priority', ticket.priority,
          'ticketPath', '/support/tickets/' || ticket.id
        ), CASE WHEN ticket.priority IN ('urgent', 'critical') THEN 'urgent' WHEN ticket.priority = 'high' THEN 'high' ELSE 'normal' END,
        COALESCE(ticket.metadata->>'sourceChannel', ticket.category), ticket.category,
        'A customer replied to this support ticket.', 'Review the latest customer reply and respond.',
        ticket.sla_deadline, 'pending'
      ) ON CONFLICT (user_id, event_key) DO NOTHING;
      RETURN NEW;
    END;
    $$
  `);
  await client.query(`
    DROP TRIGGER IF EXISTS support_customer_reply_event_trg ON support_ticket_messages;
    CREATE TRIGGER support_customer_reply_event_trg
      AFTER INSERT ON support_ticket_messages
      FOR EACH ROW EXECUTE FUNCTION enqueue_support_customer_reply_event()
  `);

  await client.query(`
    CREATE OR REPLACE FUNCTION enqueue_support_delivery_failure_event()
    RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
    DECLARE ticket RECORD;
    BEGIN
      IF NEW.status NOT IN ('failed','uncertain') OR (TG_OP='UPDATE' AND OLD.status=NEW.status) THEN RETURN NEW; END IF;
      SELECT * INTO ticket FROM support_tickets WHERE user_id=NEW.user_id
        AND outreach_conversation_id=NEW.conversation_id AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1;
      IF NOT FOUND THEN RETURN NEW; END IF;
      INSERT INTO support_notification_events(user_id,ticket_id,event_type,event_key,assigned_member_id,team_id,payload,severity,
        source_channel,category,safe_summary,required_action,sla_deadline,processing_status)
      VALUES(NEW.user_id,ticket.id,'delivery_failed','support-delivery:'||NEW.id||':'||NEW.status,ticket.assigned_member_id,ticket.team_id,
        jsonb_build_object('ticketId',ticket.id,'ticketNumber',ticket.ticket_number,'priority',ticket.priority,'ticketPath','/support/tickets/'||ticket.id),
        CASE WHEN ticket.priority IN('urgent','critical') THEN 'urgent' ELSE 'high' END,NEW.channel,ticket.category,
        'A customer-facing support reply was not confirmed as delivered.','Review delivery status and contact the customer through an approved channel.',
        ticket.sla_deadline,'pending') ON CONFLICT(user_id,event_key) DO NOTHING;
      RETURN NEW;
    END; $$
  `);
  await client.query(`
    DROP TRIGGER IF EXISTS support_delivery_failure_event_trg ON support_delivery_outbox;
    CREATE TRIGGER support_delivery_failure_event_trg AFTER INSERT OR UPDATE OF status ON support_delivery_outbox
      FOR EACH ROW EXECUTE FUNCTION enqueue_support_delivery_failure_event()
  `);

  await client.query(`
    CREATE OR REPLACE FUNCTION enqueue_support_approval_event()
    RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
    DECLARE ticket RECORD;
    BEGIN
      IF NEW.status<>'pending' OR (TG_OP='UPDATE' AND OLD.status=NEW.status) THEN RETURN NEW; END IF;
      SELECT * INTO ticket FROM support_tickets WHERE user_id=NEW.user_id AND outreach_conversation_id=NEW.thread_id
        AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1;
      IF NOT FOUND THEN RETURN NEW; END IF;
      INSERT INTO support_notification_events(user_id,ticket_id,event_type,event_key,assigned_member_id,team_id,payload,severity,
        category,safe_summary,required_action,sla_deadline,processing_status)
      VALUES(NEW.user_id,ticket.id,'approval_required','support-approval:'||NEW.id,ticket.assigned_member_id,ticket.team_id,
        jsonb_build_object('ticketId',ticket.id,'ticketNumber',ticket.ticket_number,'priority',ticket.priority,'ticketPath','/support/tickets/'||ticket.id),
        'high',ticket.category,'A governed support action is waiting for approval.','Review the pending action in the support portal.',ticket.sla_deadline,'pending')
      ON CONFLICT(user_id,event_key) DO NOTHING;
      RETURN NEW;
    END; $$
  `);
  await client.query(`
    DROP TRIGGER IF EXISTS support_approval_event_trg ON tool_approvals;
    CREATE TRIGGER support_approval_event_trg AFTER INSERT OR UPDATE OF status ON tool_approvals
      FOR EACH ROW EXECUTE FUNCTION enqueue_support_approval_event()
  `);

  await client.query(`
    CREATE OR REPLACE FUNCTION enqueue_support_handoff_notification_event()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
    DECLARE ticket RECORD;
    BEGIN
      IF NEW.support_ticket_id IS NULL OR NEW.status NOT IN ('waiting', 'assigned', 'in_progress') THEN RETURN NEW; END IF;
      SELECT * INTO ticket FROM support_tickets WHERE id = NEW.support_ticket_id AND user_id = NEW.user_id;
      IF NOT FOUND THEN RETURN NEW; END IF;
      INSERT INTO support_notification_events (
        user_id, ticket_id, handoff_id, event_type, event_key, assigned_member_id, team_id,
        payload, severity, source_channel, category, safe_summary, required_action,
        sla_deadline, processing_status
      ) VALUES (
        NEW.user_id, ticket.id, NEW.id, 'human_handoff', 'human-handoff:' || NEW.id,
        NEW.assigned_member_id, NEW.team_id,
        jsonb_build_object(
          'ticketId', ticket.id,
          'ticketNumber', ticket.ticket_number,
          'priority', NEW.priority,
          'sourceChannel', NEW.channel,
          'ticketPath', '/support/tickets/' || ticket.id
        ), CASE WHEN NEW.priority = 'urgent' THEN 'urgent' WHEN NEW.priority = 'high' THEN 'high' ELSE 'normal' END,
        NEW.channel, ticket.category,
        CASE WHEN NEW.reason ILIKE '%knowledge%' OR NEW.reason ILIKE '%retrieval%'
          THEN 'Verified information was insufficient and a human review is required.'
          ELSE 'The support agent requested human assistance for this conversation.' END,
        'Review the handoff context and reply to the customer.', NEW.sla_deadline, 'pending'
      ) ON CONFLICT (user_id, event_key) DO NOTHING;
      RETURN NEW;
    END;
    $$
  `);
  await client.query(`
    DROP TRIGGER IF EXISTS support_handoff_notification_event_trg ON handoff_queue;
    CREATE TRIGGER support_handoff_notification_event_trg
      AFTER INSERT OR UPDATE OF support_ticket_id, status ON handoff_queue
      FOR EACH ROW EXECUTE FUNCTION enqueue_support_handoff_notification_event()
  `);

  await client.query(`
    CREATE OR REPLACE FUNCTION claim_pending_support_notification_events(batch_limit INTEGER)
    RETURNS TABLE(id BIGINT, user_id INTEGER)
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
    BEGIN
      RETURN QUERY
      WITH candidates AS (
        SELECT e.id
        FROM support_notification_events e
        WHERE (
          e.processing_status IN ('pending', 'retry')
          OR (e.processing_status = 'processing' AND e.next_attempt_at < NOW() - INTERVAL '5 minutes')
        )
          AND e.next_attempt_at <= NOW()
        ORDER BY CASE e.severity WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 ELSE 3 END, e.created_at
        FOR UPDATE SKIP LOCKED
        LIMIT LEAST(GREATEST(batch_limit, 1), 200)
      )
      UPDATE support_notification_events e
      SET processing_status = 'processing',
          processing_attempts = processing_attempts + 1,
          processing_error = NULL,
          next_attempt_at = NOW(),
          expanded_at = NULL
      FROM candidates c
      WHERE e.id = c.id
      RETURNING e.id, e.user_id;
    END;
    $$
  `);

  await client.query(`
    CREATE OR REPLACE FUNCTION claim_due_support_notification_deliveries(batch_limit INTEGER)
    RETURNS TABLE(id BIGINT, user_id INTEGER)
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
    BEGIN
      RETURN QUERY
      WITH candidates AS (
        SELECT d.id
        FROM support_member_notification_deliveries d
        WHERE (
          d.status IN ('pending', 'retry')
          OR (d.status = 'sending' AND d.updated_at < NOW() - INTERVAL '5 minutes')
        )
          AND d.attempt_count < d.max_attempts
          AND d.next_attempt_at <= NOW()
        ORDER BY d.created_at
        FOR UPDATE SKIP LOCKED
        LIMIT LEAST(GREATEST(batch_limit, 1), 200)
      )
      SELECT d.id, d.user_id
      FROM support_member_notification_deliveries d
      JOIN candidates c ON c.id = d.id;
    END;
    $$
  `);

  // Called only after a provider webhook signature is verified. It permits
  // delivery-state reconciliation without granting the application role a
  // cross-tenant notification-table bypass.
  await client.query(`
    CREATE OR REPLACE FUNCTION reconcile_support_notification_provider_delivery(
      external_message_id TEXT, external_status TEXT, occurred_at TIMESTAMP, failure_reason TEXT DEFAULT NULL
    ) RETURNS INTEGER
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    DECLARE changed INTEGER;
    BEGIN
      IF external_status NOT IN ('sent','accepted','delivered','read','failed','bounced','complained','uncertain') THEN
        RETURN 0;
      END IF;
      UPDATE support_member_notification_deliveries SET
        status = CASE
          WHEN external_status = 'read' THEN 'read'
          WHEN external_status = 'delivered' AND status <> 'read' THEN 'delivered'
          WHEN external_status IN ('sent','accepted') AND status NOT IN ('delivered','read') THEN 'accepted'
          WHEN external_status IN ('failed','bounced','complained') AND status NOT IN ('delivered','read') THEN 'failed'
          WHEN external_status = 'uncertain' AND status NOT IN ('delivered','read') THEN 'uncertain'
          ELSE status END,
        provider_status = external_status,
        accepted_at = CASE WHEN external_status IN ('sent','accepted') THEN COALESCE(accepted_at, occurred_at) ELSE accepted_at END,
        delivered_at = CASE WHEN external_status IN ('delivered','read') THEN COALESCE(delivered_at, occurred_at) ELSE delivered_at END,
        read_at = CASE WHEN external_status = 'read' THEN COALESCE(read_at, occurred_at) ELSE read_at END,
        error_code = CASE WHEN external_status IN ('failed','bounced','complained') THEN upper(external_status) ELSE error_code END,
        last_error = CASE WHEN external_status IN ('failed','bounced','complained') THEN LEFT(failure_reason, 2000) ELSE last_error END,
        updated_at = NOW()
      WHERE provider_message_id = external_message_id;
      GET DIAGNOSTICS changed = ROW_COUNT;
      RETURN changed;
    END; $$
  `);

  // RLS is enforced on every tenant-bearing notification table. Runtime reads
  // and writes use transaction-scoped app.current_user_id.
  for (const table of [
    'support_notification_destinations',
    'support_notification_preferences',
    'support_notification_events',
    'support_notification_receipts',
    'support_member_notification_deliveries',
    'support_notification_audit_logs',
    'support_notification_templates',
    'support_notification_template_versions',
    'support_notification_policies',
    'support_notification_escalations',
  ]) {
    await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await client.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    await client.query(`DROP POLICY IF EXISTS ${table}_tenant_policy ON ${table}`);
    await client.query(`
      CREATE POLICY ${table}_tenant_policy ON ${table}
        USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::INTEGER)
        WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::INTEGER)
    `);
  }
}

export async function down(client) {
  await client.query('DROP FUNCTION IF EXISTS reconcile_support_notification_provider_delivery(TEXT, TEXT, TIMESTAMP, TEXT)');
  await client.query('DROP TRIGGER IF EXISTS support_delivery_failure_event_trg ON support_delivery_outbox');
  await client.query('DROP FUNCTION IF EXISTS enqueue_support_delivery_failure_event()');
  await client.query('DROP TRIGGER IF EXISTS support_approval_event_trg ON tool_approvals');
  await client.query('DROP FUNCTION IF EXISTS enqueue_support_approval_event()');
  await client.query('DROP FUNCTION IF EXISTS claim_due_support_notification_deliveries(INTEGER)');
  await client.query('DROP FUNCTION IF EXISTS claim_pending_support_notification_events(INTEGER)');
  await client.query('DROP TRIGGER IF EXISTS support_handoff_notification_event_trg ON handoff_queue');
  await client.query('DROP FUNCTION IF EXISTS enqueue_support_handoff_notification_event()');
  await client.query('DROP TRIGGER IF EXISTS support_customer_reply_event_trg ON support_ticket_messages');
  await client.query('DROP FUNCTION IF EXISTS enqueue_support_customer_reply_event()');
  await client.query('DROP TRIGGER IF EXISTS support_ticket_notification_event_trg ON support_tickets');
  await client.query('DROP FUNCTION IF EXISTS enqueue_support_ticket_notification_event()');
  await client.query('DROP TRIGGER IF EXISTS support_ticket_team_resolution_trg ON support_tickets');
  await client.query('DROP FUNCTION IF EXISTS resolve_support_ticket_team()');
  await client.query('DROP TABLE IF EXISTS support_notification_escalations');
  await client.query('DROP TABLE IF EXISTS support_notification_policies');
  await client.query('DROP TABLE IF EXISTS support_notification_template_versions');
  await client.query('DROP TABLE IF EXISTS support_notification_templates');
  await client.query('DROP INDEX IF EXISTS notifications_user_event_key_uq');
  await client.query('ALTER TABLE notifications DROP COLUMN IF EXISTS event_key');
}
