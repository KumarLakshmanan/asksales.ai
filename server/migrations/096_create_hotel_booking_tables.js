/**
 * Migration 096: Hotel booking domain tables for the WhatsApp Sales Agent.
 *
 * Creates:
 *   - hotel_properties   : one property per row (multi-tenant via user_id)
 *   - room_types         : room categories with base/min price + max discount %
 *   - room_availability  : per-date inventory + nightly price (local availability provider)
 *   - bookings           : the booking journey (inquiry -> tentative -> pending_payment -> confirmed)
 *
 * Idempotent (IF NOT EXISTS) and reversible. Pure SQL via the pg client passed by migrate.mjs.
 */

export async function up(client) {
  // ── hotel_properties ────────────────────────────────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS hotel_properties (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      address VARCHAR(500),
      city VARCHAR(120),
      country VARCHAR(120),
      currency VARCHAR(10) NOT NULL DEFAULT 'INR',
      check_in_time TIME DEFAULT '14:00',
      check_out_time TIME DEFAULT '11:00',
      amenities JSONB DEFAULT '[]'::jsonb,
      policies JSONB DEFAULT '{}'::jsonb,
      description TEXT,
      phone VARCHAR(40),
      email VARCHAR(255),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_hotel_properties_user_id ON hotel_properties(user_id)`);

  // ── room_types ──────────────────────────────────────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS room_types (
      id SERIAL PRIMARY KEY,
      hotel_id INTEGER NOT NULL REFERENCES hotel_properties(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      capacity INTEGER NOT NULL DEFAULT 1,
      base_price DECIMAL(10,2) NOT NULL,
      min_price DECIMAL(10,2) NOT NULL,
      max_discount_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
      amenities JSONB DEFAULT '[]'::jsonb,
      image_url TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_room_types_hotel_id ON room_types(hotel_id)`);

  // ── room_availability ───────────────────────────────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS room_availability (
      id SERIAL PRIMARY KEY,
      room_type_id INTEGER NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      available_count INTEGER NOT NULL DEFAULT 0,
      price_per_night DECIMAL(10,2) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(room_type_id, date)
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_room_availability_date ON room_availability(date)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_room_availability_type_date ON room_availability(room_type_id, date)`);

  // ── bookings ────────────────────────────────────────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
      outreach_conversation_id INTEGER REFERENCES outreach_conversations(id) ON DELETE SET NULL,
      hotel_property_id INTEGER NOT NULL REFERENCES hotel_properties(id) ON DELETE CASCADE,
      room_type_id INTEGER NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
      guest_name VARCHAR(255),
      guest_email VARCHAR(255),
      guest_phone VARCHAR(40),
      check_in_date DATE NOT NULL,
      check_out_date DATE NOT NULL,
      nights INTEGER NOT NULL DEFAULT 1,
      number_of_guests INTEGER NOT NULL DEFAULT 1,
      number_of_rooms INTEGER NOT NULL DEFAULT 1,
      base_total DECIMAL(12,2),
      agreed_price_per_night DECIMAL(10,2),
      total_price DECIMAL(12,2),
      currency VARCHAR(10) NOT NULL DEFAULT 'INR',
      status VARCHAR(40) NOT NULL DEFAULT 'inquiry',
      payment_status VARCHAR(40) NOT NULL DEFAULT 'pending',
      payment_provider VARCHAR(40),
      payment_ref VARCHAR(255),
      payment_link TEXT,
      special_requests TEXT,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_bookings_user_id ON bookings(user_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_bookings_conversation_id ON bookings(outreach_conversation_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_bookings_payment_ref ON bookings(payment_ref)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_bookings_check_in_date ON bookings(check_in_date)`);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS bookings`);
  await client.query(`DROP TABLE IF EXISTS room_availability`);
  await client.query(`DROP TABLE IF EXISTS room_types`);
  await client.query(`DROP TABLE IF EXISTS hotel_properties`);
}
