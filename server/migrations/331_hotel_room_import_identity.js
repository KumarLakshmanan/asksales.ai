/** Enforce the existing exact hotel/name identity across imports and admin writes.
 * Never merge or delete existing room/inventory/booking rows automatically. */
export async function up(client) {
  const duplicates = await client.query(
    "SELECT hotel_id,name FROM room_types GROUP BY hotel_id,name HAVING count(*)>1 LIMIT 1",
  );
  if (duplicates.rows.length)
    throw new Error(
      "Duplicate hotel room names require owner review before enabling the identity constraint. No rooms were changed.",
    );
  await client.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS room_types_hotel_name_import_uq ON room_types(hotel_id,name)",
  );
}
export async function down(client) {
  await client.query("DROP INDEX IF EXISTS room_types_hotel_name_import_uq");
}
