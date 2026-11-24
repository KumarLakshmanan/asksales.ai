import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { Client } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { getTableColumns, type SQL } from "drizzle-orm";
import { crmActivityRemindersTable } from "../models/crmActivityReminders/schema.js";
const url = process.env.FOLLOW_UP_IMPLEMENTATION_DATABASE_URL;
const suite = url ? describe : describe.skip;
let client: Client;
let database: NodePgDatabase;
let failReceipt = false;
const dialect = new PgDialect();
jest.unstable_mockModule("../models/db.js", () => ({
  db: new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "execute")
          return (query: SQL) => {
            if (
              failReceipt &&
              dialect.sqlToQuery(query).sql.includes("='sending' RETURNING id")
            ) {
              failReceipt = false;
              throw new Error("Synthetic receipt persistence failure");
            }
            return database.execute(query);
          };
        const value = (database as unknown as Record<PropertyKey, unknown>)[
          property
        ];
        return typeof value === "function" ? value.bind(database) : value;
      },
    },
  ),
}));
jest.unstable_mockModule("../services/adminEmailService.js", () => ({
  sendAdminEmail: async () => {
    throw new Error("No provider calls in receipt tests");
  },
}));
const { reminderService } = await import("../services/ReminderService.js");
const { deliverReminderNotification, ReminderNotificationUncertainError } =
  await import("../services/ReminderNotificationDeliveryService.js");
const reminder = {
  id: 1,
  userId: 7,
  businessProfileId: 10,
  metadata: { notifyContact: true },
};
suite(
  "per-destination reminder receipts against TEMP PostgreSQL tables",
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
    });
    beforeEach(async () => {
      failReceipt = false;
      await client.query(
        "TRUNCATE crm_activity_reminders;INSERT INTO crm_activity_reminders(id,user_id,business_profile_id,status,metadata,updated_at) VALUES(1,7,10,'pending','{\"notifyContact\":true}',NOW())",
      );
    });
    afterAll(async () => {
      await client?.end();
    });
    it("retries only a rejected destination and skips the already accepted internal notification", async () => {
      const internal = jest
        .fn<any>()
        .mockResolvedValue({ success: true, messageId: "synthetic-internal" });
      const contact = jest
        .fn<any>()
        .mockResolvedValueOnce({
          success: false,
          outcomeUncertain: false,
          error: "Synthetic rejection",
        })
        .mockResolvedValue({ success: true, messageId: "synthetic-contact" });
      await deliverReminderNotification(reminder, "internal", internal);
      await expect(
        deliverReminderNotification(reminder, "contact", contact),
      ).rejects.toThrow("Synthetic rejection");
      expect(
        await deliverReminderNotification(reminder, "internal", internal),
      ).toEqual({ skipped: true });
      await deliverReminderNotification(reminder, "contact", contact);
      expect(internal).toHaveBeenCalledTimes(1);
      expect(contact).toHaveBeenCalledTimes(2);
      const metadata = (
        await client.query("SELECT metadata FROM crm_activity_reminders")
      ).rows[0].metadata;
      expect(metadata.notificationDeliveries.initial).toMatchObject({
        internal: { state: "sent" },
        contact: { state: "sent" },
      });
    });
    it("does not resend after provider acceptance followed by a lost receipt write", async () => {
      const send = jest.fn<any>().mockImplementation(async () => {
        failReceipt = true;
        return { success: true, messageId: "synthetic-accepted" };
      });
      await expect(
        deliverReminderNotification(reminder, "internal", send),
      ).rejects.toThrow("Synthetic receipt persistence failure");
      await expect(
        deliverReminderNotification(reminder, "internal", send),
      ).rejects.toBeInstanceOf(ReminderNotificationUncertainError);
      expect(send).toHaveBeenCalledTimes(1);
    });
    it("retains ambiguous provider outcomes for review instead of automatically retrying", async () => {
      const send = jest
        .fn<any>()
        .mockResolvedValue({ success: false, error: "Connection lost" });
      await expect(
        deliverReminderNotification(reminder, "contact", send),
      ).rejects.toBeInstanceOf(ReminderNotificationUncertainError);
      await expect(
        deliverReminderNotification(reminder, "contact", send),
      ).rejects.toBeInstanceOf(ReminderNotificationUncertainError);
      expect(send).toHaveBeenCalledTimes(1);
    });
    it("allows one new notification after an explicit committed reschedule generation", async () => {
      const send = jest.fn<any>().mockResolvedValue({ success: true });
      await deliverReminderNotification(reminder, "internal", send);
      await client.query(
        'UPDATE crm_activity_reminders SET metadata=metadata || \'{"notificationGeneration":"rescheduled"}\'::jsonb',
      );
      await deliverReminderNotification(
        { ...reminder, metadata: { notificationGeneration: "rescheduled" } },
        "internal",
        send,
      );
      expect(send).toHaveBeenCalledTimes(2);
      const metadata = (
        await client.query("SELECT metadata FROM crm_activity_reminders")
      ).rows[0].metadata;
      expect(metadata.notificationDeliveries.initial.internal.state).toBe(
        "sent",
      );
      expect(metadata.notificationDeliveries.rescheduled.internal.state).toBe(
        "sent",
      );
    });
    it("rejects a foreign business and prevents concurrent duplicate provider calls", async () => {
      const send = jest.fn<any>().mockResolvedValue({ success: true });
      await expect(
        deliverReminderNotification(
          { ...reminder, businessProfileId: 11 },
          "internal",
          send,
        ),
      ).rejects.toBeInstanceOf(ReminderNotificationUncertainError);
      expect(send).not.toHaveBeenCalled();
      const results = await Promise.allSettled([
        deliverReminderNotification(reminder, "internal", send),
        deliverReminderNotification(reminder, "internal", send),
      ]);
      expect(results.some((result) => result.status === "fulfilled")).toBe(
        true,
      );
      expect(send).toHaveBeenCalledTimes(1);
    });
    it("preserves fresh destination receipts when the reminder retry writes stale metadata", async () => {
      const send = jest.fn<any>().mockResolvedValue({ success: true });
      await deliverReminderNotification(reminder, "internal", send);
      await (
        reminderService as unknown as {
          updateActivityReminderDeliveryState: (
            id: number,
            changes: unknown,
          ) => Promise<void>;
        }
      ).updateActivityReminderDeliveryState(1, {
        metadata: { notifyContact: true, retry_count: 1 },
        status: "pending",
        lastSentAt: null,
      });
      expect(
        await deliverReminderNotification(reminder, "internal", send),
      ).toEqual({ skipped: true });
      expect(send).toHaveBeenCalledTimes(1);
      const metadata = (
        await client.query("SELECT metadata FROM crm_activity_reminders")
      ).rows[0].metadata;
      expect(metadata.retry_count).toBe(1);
      expect(metadata.notificationDeliveries.initial.internal.state).toBe(
        "sent",
      );
    });
  },
);
