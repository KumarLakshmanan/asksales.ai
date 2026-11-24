import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { getTableColumns } from "drizzle-orm";
import { crmActivityRemindersTable } from "../models/crmActivityReminders/schema.js";

const url = process.env.FOLLOW_UP_IMPLEMENTATION_DATABASE_URL;
const suite = url ? describe : describe.skip;
let client: Client;
let database: NodePgDatabase;
let loseAcknowledgementForKind: string | undefined;
const sendAdminEmail = jest.fn(async () => {
  throw new Error(
    "Provider calls are disabled in booking reminder persistence tests",
  );
});

jest.unstable_mockModule("../models/db.js", () => ({
  db: {
    insert: (table: Parameters<NodePgDatabase["insert"]>[0]) => ({
      values: (values: typeof crmActivityRemindersTable.$inferInsert) => ({
        onConflictDoNothing: async () => {
          const result = await database
            .insert(table)
            .values(values)
            .onConflictDoNothing();
          if (
            loseAcknowledgementForKind === values.metadata?.bookingReminderKind
          ) {
            loseAcknowledgementForKind = undefined;
            throw new Error("Synthetic lost insert acknowledgement");
          }
          return result;
        },
      }),
    }),
  },
}));
jest.unstable_mockModule("../services/adminEmailService.js", () => ({
  sendAdminEmail,
}));
jest.unstable_mockModule("../utils/logger.js", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));
const { reminderService } = await import("../services/ReminderService.js");
const booking = {
  id: 91,
  checkIn: "2099-06-15",
  checkOut: "2099-06-17",
  guestName: "Synthetic guest",
  timezone: "UTC",
};

suite(
  "booking reminder persistence and safe retry against TEMP PostgreSQL tables",
  () => {
    beforeAll(async () => {
      if (
        !url ||
        !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname) ||
        new URL(url).pathname !== "/followup_qa"
      )
        throw new Error("Disposable local followup_qa database required");
      client = new Client({ connectionString: url });
      await client.connect();
      await client.query("SET search_path TO pg_temp,pg_catalog");
      database = drizzle(client);
      const columns = Object.values(
        getTableColumns(crmActivityRemindersTable),
      ).map((column) => `"${column.name}" ${column.getSQLType()}`);
      await client.query(
        `CREATE TEMP TABLE crm_activity_reminders(${columns.join(",")})`,
      );
      await client.query(`
      ALTER TABLE crm_activity_reminders
        ADD PRIMARY KEY (id),
        ALTER user_id SET NOT NULL,
        ALTER business_profile_id SET NOT NULL,
        ALTER business_profile_id SET DEFAULT current_setting('audit.business_profile_id')::integer,
        ALTER status SET DEFAULT 'pending',
        ALTER metadata SET DEFAULT '{}'::jsonb,
        ALTER created_at SET DEFAULT NOW(),
        ALTER updated_at SET DEFAULT NOW();
      CREATE FUNCTION pg_temp.reject_booking_reminder() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.metadata->>'bookingReminderKind' = current_setting('audit.reject_booking_kind',true) THEN
          RAISE EXCEPTION 'Synthetic booking reminder persistence failure' USING ERRCODE='40001';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER reject_booking_reminder BEFORE INSERT ON crm_activity_reminders
        FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_booking_reminder();
    `);
      // Exercise the existing production uniqueness definition without applying a migration or changing it.
      const migration = readFileSync(
        new URL(
          "../migrations/132_harden_hotel_booking_lifecycle.js",
          import.meta.url,
        ),
        "utf8",
      );
      const index = migration.match(
        /CREATE UNIQUE INDEX IF NOT EXISTS crm_booking_reminder_unique[\s\S]*?;/,
      )?.[0];
      if (!index)
        throw new Error(
          "Existing hotel reminder uniqueness index was not found",
        );
      await client.query(index);
    });
    beforeEach(async () => {
      loseAcknowledgementForKind = undefined;
      sendAdminEmail.mockClear();
      await client.query(`TRUNCATE crm_activity_reminders RESTART IDENTITY;
      SET audit.business_profile_id='10'; SET audit.reject_booking_kind='';`);
    });
    afterAll(async () => {
      await client?.end();
    });

    it.each([
      ["check_in", 0],
      ["check_out", 1],
    ] as const)(
      "rejects a real %s insert failure and fills only missing reminders on retry",
      async (kind, savedCount) => {
        await client.query(
          "SELECT set_config('audit.reject_booking_kind',$1,false)",
          [kind],
        );
        await expect(
          reminderService.scheduleBookingReminders(7, booking, null),
        ).rejects.toMatchObject({
          cause: expect.objectContaining({ code: "40001" }),
        });
        expect(
          (await client.query("SELECT * FROM crm_activity_reminders")).rows,
        ).toHaveLength(savedCount);
        await client.query("SET audit.reject_booking_kind=''");
        await expect(
          reminderService.scheduleBookingReminders(7, booking, null),
        ).resolves.toBeUndefined();
        await reminderService.scheduleBookingReminders(7, booking, null);
        const rows = (
          await client.query(
            "SELECT business_profile_id,user_id,metadata FROM crm_activity_reminders ORDER BY id",
          )
        ).rows;
        expect(rows).toHaveLength(2);
        expect(
          rows.map((row) => row.metadata.bookingReminderKind).sort(),
        ).toEqual(["check_in", "check_out"]);
        expect(
          rows.every(
            (row) =>
              row.business_profile_id === 10 &&
              row.user_id === 7 &&
              row.metadata.notifyContact === false,
          ),
        ).toBe(true);
        expect(sendAdminEmail).not.toHaveBeenCalled();
      },
    );

    it("retries a lost acknowledgement without resetting accepted or uncertain delivery receipts", async () => {
      loseAcknowledgementForKind = "check_out";
      await expect(
        reminderService.scheduleBookingReminders(7, booking, null),
      ).rejects.toThrow("Synthetic lost insert acknowledgement");
      await client.query(`UPDATE crm_activity_reminders SET status='sent',sent_at=NOW(),metadata=metadata ||
      '{"notificationDeliveries":{"initial":{"internal":{"state":"sent","messageId":"synthetic-receipt"}}}}'::jsonb
      WHERE metadata->>'bookingReminderKind'='check_in';
      UPDATE crm_activity_reminders SET metadata=metadata ||
      '{"notificationDeliveries":{"initial":{"internal":{"state":"unknown"}}}}'::jsonb
      WHERE metadata->>'bookingReminderKind'='check_out';`);
      const before = (
        await client.query("SELECT * FROM crm_activity_reminders ORDER BY id")
      ).rows;
      await reminderService.scheduleBookingReminders(7, booking, null);
      expect(
        (await client.query("SELECT * FROM crm_activity_reminders ORDER BY id"))
          .rows,
      ).toEqual(before);
      expect(sendAdminEmail).not.toHaveBeenCalled();
    });

    it("keeps distinct users and booking IDs separate while repeated same-booking calls remain idempotent", async () => {
      await reminderService.scheduleBookingReminders(7, booking, null);
      await client.query("SET audit.business_profile_id='20'");
      await reminderService.scheduleBookingReminders(8, booking, null);
      await reminderService.scheduleBookingReminders(
        8,
        { ...booking, id: 92 },
        null,
      );
      await reminderService.scheduleBookingReminders(8, booking, null);
      const rows = (
        await client.query(
          "SELECT user_id,business_profile_id,metadata FROM crm_activity_reminders",
        )
      ).rows;
      expect(rows).toHaveLength(6);
      expect(
        rows.filter(
          (row) => row.user_id === 7 && row.business_profile_id === 10,
        ),
      ).toHaveLength(2);
      expect(
        rows.filter(
          (row) => row.user_id === 8 && row.business_profile_id === 20,
        ),
      ).toHaveLength(4);
    });
  },
);
