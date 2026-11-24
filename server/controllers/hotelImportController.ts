import { businessOwnerUserId } from "../tenancy/businessContext.js";
import { Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../models/db.js";
import { hotelRagSyncService } from "../services/booking/HotelRagSyncService.js";
import { logger } from "../utils/logger.js";
import {
  HotelRateImportError,
  parseHotelRateWorkbook,
} from "../utils/hotelRateImport.js";

export async function importRateReport(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  try {
    const data = parseHotelRateWorkbook(req.file.buffer);
    const requested =
      req.body?.hotelId == null ? undefined : Number(req.body.hotelId);
    if (
      requested !== undefined &&
      (!Number.isSafeInteger(requested) || requested <= 0)
    )
      throw new HotelRateImportError("hotelId must identify a property.");
    const result = await db.transaction(async (tx: typeof db) => {
      // Share property setup's lock, including first-property creation. Existing
      // duplicates require review; never merge booking inventories. Do not lock
      // the property row before its rooms: booking creation locks rt then hp.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${userId}, 132)`);
      const hotels =
        await tx.execute(sql`SELECT id FROM hotel_properties WHERE user_id=${userId}
        ${requested === undefined ? sql`` : sql`AND id=${requested}`} ORDER BY id LIMIT 2`);
      if (hotels.rows.length > 1)
        throw new HotelRateImportError(
          "Choose a hotelId before importing into an account with multiple properties.",
          409,
        );
      if (requested && !hotels.rows.length)
        throw new HotelRateImportError("Hotel property not found.", 404);
      const hotelId = Number(
        hotels.rows[0]?.id ??
          (
            await tx.execute(sql`INSERT INTO hotel_properties(user_id,name)
        VALUES(${userId},'Default Hotel') RETURNING id`)
          ).rows[0].id,
      );
      const roomIds = new Set<number>();
      let roomTypesCreated = 0;
      for (const row of data) {
        const rooms = await tx.execute(
          sql`SELECT id FROM room_types WHERE hotel_id=${hotelId} AND name=${row.name} ORDER BY id LIMIT 2 FOR UPDATE`,
        );
        if (rooms.rows.length > 1)
          throw new HotelRateImportError(
            "This property has duplicate room types. Review them before importing.",
            409,
            row.row,
          );
        let roomId = Number(rooms.rows[0]?.id);
        if (!roomId) {
          roomId = Number(
            (
              await tx.execute(sql`INSERT INTO room_types(hotel_id,name,base_price,min_price,capacity)
            VALUES(${hotelId},${row.name},${row.rate},${row.rate * 0.8},${Math.max(1, row.total)}) RETURNING id`)
            ).rows[0].id,
          );
          roomTypesCreated++;
        }
        // Booking holds lock the room before nightly inventory. Releases lock
        // nightly rows too; take that lock before reading occupancy in a NEW
        // statement so the snapshot includes any release that just committed.
        await tx.execute(sql`SELECT id FROM room_availability
          WHERE room_type_id=${roomId} AND date=${row.day}::date FOR UPDATE`);
        const occupied = await tx.execute(sql`SELECT COALESCE(SUM(number_of_rooms), 0)::integer AS rooms
          FROM bookings WHERE room_type_id=${roomId}
            AND check_in_date<=${row.day}::date AND check_out_date>${row.day}::date
            AND (status='confirmed' OR (status='pending_payment'
              AND inventory_reserved_at IS NOT NULL AND inventory_released_at IS NULL))`);
        const reserved = Number(occupied.rows[0]?.rooms || 0);
        if (row.total < reserved)
          throw new HotelRateImportError(
            'Total inventory cannot be lower than rooms already held or confirmed. No report rows were imported.',
            409,
            row.row,
          );
        // Expired but unreleased holds still own stock until release commits.
        const freeRooms = Math.min(row.availability, row.total - reserved);
        await tx.execute(sql`INSERT INTO room_availability(room_type_id,date,total_count,available_count,price_per_night)
          VALUES(${roomId},${row.day},${row.total},${freeRooms},${row.rate})
          ON CONFLICT(room_type_id,date) DO UPDATE SET total_count=EXCLUDED.total_count,
            available_count=EXCLUDED.available_count,price_per_night=EXCLUDED.price_per_night,updated_at=NOW()`);
        roomIds.add(roomId);
      }
      return { roomIds: [...roomIds], roomTypesCreated };
    });
    // Never remove a derived index for a rolled-back import.
    for (const roomId of result.roomIds)
      await hotelRagSyncService
        .deleteRoomTypeFromRag(userId, roomId)
        .catch((err) =>
          logger.warn(
            { err, roomId },
            "[HotelImport] Post-commit legacy index cleanup failed",
          ),
        );
    return res.json({
      success: true,
      imported: data.length,
      roomTypesCreated: result.roomTypesCreated,
      availabilityUpdated: data.length,
      rows: data.length,
    });
  } catch (error) {
    if (error instanceof HotelRateImportError)
      return res
        .status(error.status)
        .json({
          error: error.message,
          ...(error.row ? { row: error.row } : {}),
        });
    logger.error({ err: error }, "[HotelImport] Rate import rolled back");
    return res
      .status(500)
      .json({
        error:
          "Failed to import rate report. No rate-report changes were committed.",
      });
  }
}
