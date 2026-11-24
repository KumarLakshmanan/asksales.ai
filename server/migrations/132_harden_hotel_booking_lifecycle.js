/**
 * Harden hotel inventory, payment, cancellation, and notification lifecycle.
 *
 * Existing confirmed bookings already reduced `available_count`, so their
 * inventory is marked reserved during backfill without reducing it again.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE hotel_properties
      ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) NOT NULL DEFAULT 'UTC';

    ALTER TABLE room_availability
      ADD COLUMN IF NOT EXISTS total_count INTEGER;

    UPDATE room_availability ra
    SET total_count = ra.available_count + COALESCE((
      SELECT SUM(b.number_of_rooms)::integer
      FROM bookings b
      WHERE b.room_type_id = ra.room_type_id
        AND b.status = 'confirmed'
        AND b.check_in_date <= ra.date
        AND b.check_out_date > ra.date
    ), 0)
    WHERE total_count IS NULL;

    ALTER TABLE room_availability
      ALTER COLUMN total_count SET DEFAULT 0,
      ALTER COLUMN total_count SET NOT NULL;

    ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(64),
      ADD COLUMN IF NOT EXISTS inventory_reserved_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS inventory_released_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS hold_expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
      ADD COLUMN IF NOT EXISTS payment_id VARCHAR(255),
      ADD COLUMN IF NOT EXISTS payment_link_claimed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS payment_link_error TEXT,
      ADD COLUMN IF NOT EXISTS confirmation_notification_claimed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS confirmation_notified_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS side_effects_processed_at TIMESTAMPTZ;

    UPDATE bookings
    SET inventory_reserved_at = COALESCE(inventory_reserved_at, updated_at, created_at),
        confirmed_at = COALESCE(confirmed_at, updated_at, created_at)
    WHERE status = 'confirmed';

    UPDATE bookings
    SET inventory_released_at = COALESCE(inventory_released_at, updated_at, created_at),
        cancelled_at = COALESCE(cancelled_at, updated_at, created_at)
    WHERE status IN ('cancelled', 'expired');

    CREATE UNIQUE INDEX IF NOT EXISTS bookings_active_idempotency_unique
      ON bookings (idempotency_key)
      WHERE idempotency_key IS NOT NULL
        AND status IN ('pending_payment', 'confirmed');

    CREATE UNIQUE INDEX IF NOT EXISTS bookings_payment_ref_unique
      ON bookings (payment_ref)
      WHERE payment_ref IS NOT NULL;

    CREATE INDEX IF NOT EXISTS bookings_expiring_holds_idx
      ON bookings (hold_expires_at)
      WHERE status = 'pending_payment'
        AND inventory_released_at IS NULL;

    DELETE FROM crm_activity_reminders newer
    USING crm_activity_reminders older
    WHERE newer.id > older.id
      AND newer.user_id = older.user_id
      AND newer.metadata->>'source' = 'hotel_booking'
      AND older.metadata->>'source' = 'hotel_booking'
      AND newer.metadata->>'bookingId' = older.metadata->>'bookingId'
      AND newer.metadata->>'bookingReminderKind' = older.metadata->>'bookingReminderKind';

    CREATE UNIQUE INDEX IF NOT EXISTS crm_booking_reminder_unique
      ON crm_activity_reminders (
        user_id,
        (metadata->>'bookingId'),
        (metadata->>'bookingReminderKind')
      )
      WHERE metadata->>'source' = 'hotel_booking';

    DO $constraints$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'room_availability_counts_nonnegative'
      ) THEN
        ALTER TABLE room_availability
          ADD CONSTRAINT room_availability_counts_nonnegative
          CHECK (available_count >= 0 AND total_count >= 0 AND available_count <= total_count)
          NOT VALID;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'room_availability_price_nonnegative'
      ) THEN
        ALTER TABLE room_availability
          ADD CONSTRAINT room_availability_price_nonnegative
          CHECK (price_per_night >= 0)
          NOT VALID;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'bookings_valid_stay'
      ) THEN
        ALTER TABLE bookings
          ADD CONSTRAINT bookings_valid_stay
          CHECK (
            check_out_date > check_in_date
            AND nights > 0
            AND number_of_guests > 0
            AND number_of_rooms > 0
            AND COALESCE(total_price, 0) >= 0
          )
          NOT VALID;
      END IF;
    END
    $constraints$;

    ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_room_type_id_fkey;
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_room_type_id_fkey
      FOREIGN KEY (room_type_id) REFERENCES room_types(id) ON DELETE RESTRICT;

    ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_hotel_property_id_fkey;
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_hotel_property_id_fkey
      FOREIGN KEY (hotel_property_id) REFERENCES hotel_properties(id) ON DELETE RESTRICT;
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_room_type_id_fkey;
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_room_type_id_fkey
      FOREIGN KEY (room_type_id) REFERENCES room_types(id) ON DELETE CASCADE;

    ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_hotel_property_id_fkey;
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_hotel_property_id_fkey
      FOREIGN KEY (hotel_property_id) REFERENCES hotel_properties(id) ON DELETE CASCADE;

    ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_valid_stay;
    ALTER TABLE room_availability DROP CONSTRAINT IF EXISTS room_availability_price_nonnegative;
    ALTER TABLE room_availability DROP CONSTRAINT IF EXISTS room_availability_counts_nonnegative;

    DROP INDEX IF EXISTS bookings_expiring_holds_idx;
    DROP INDEX IF EXISTS crm_booking_reminder_unique;
    DROP INDEX IF EXISTS bookings_payment_ref_unique;
    DROP INDEX IF EXISTS bookings_active_idempotency_unique;

    ALTER TABLE bookings
      DROP COLUMN IF EXISTS side_effects_processed_at,
      DROP COLUMN IF EXISTS confirmation_notified_at,
      DROP COLUMN IF EXISTS confirmation_notification_claimed_at,
      DROP COLUMN IF EXISTS payment_link_error,
      DROP COLUMN IF EXISTS payment_link_claimed_at,
      DROP COLUMN IF EXISTS payment_id,
      DROP COLUMN IF EXISTS cancellation_reason,
      DROP COLUMN IF EXISTS cancelled_at,
      DROP COLUMN IF EXISTS confirmed_at,
      DROP COLUMN IF EXISTS hold_expires_at,
      DROP COLUMN IF EXISTS inventory_released_at,
      DROP COLUMN IF EXISTS inventory_reserved_at,
      DROP COLUMN IF EXISTS idempotency_key;

    ALTER TABLE room_availability DROP COLUMN IF EXISTS total_count;
    ALTER TABLE hotel_properties DROP COLUMN IF EXISTS timezone;
  `);
}
