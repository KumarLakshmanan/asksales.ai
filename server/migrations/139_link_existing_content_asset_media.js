/**
 * Links previously generated storage records to the content assets that use
 * them. New writes are linked by ContentAssetModel; this migration repairs
 * older unreferenced rows so deletion and quota cleanup are deterministic.
 */
export async function up(client) {
  await client.query(`
    WITH matches AS (
      SELECT DISTINCT ON (storage_file.id)
        storage_file.id AS storage_file_id,
        asset.id AS asset_id
      FROM storage_files AS storage_file
      JOIN content_assets AS asset
        ON asset.user_id = storage_file.user_id
      WHERE storage_file.is_deleted = false
        AND storage_file.reference_type IS NULL
        AND storage_file.url IS NOT NULL
        AND BTRIM(storage_file.url) <> ''
        AND (
          split_part(split_part(COALESCE(asset.image_url, ''), '?', 1), '#', 1)
            = split_part(split_part(storage_file.url, '?', 1), '#', 1)
          OR split_part(split_part(COALESCE(asset.video_url, ''), '?', 1), '#', 1)
            = split_part(split_part(storage_file.url, '?', 1), '#', 1)
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(asset.image_urls) = 'array'
                THEN asset.image_urls ELSE '[]'::jsonb END
            ) AS media(value)
            WHERE split_part(split_part(media.value, '?', 1), '#', 1)
              = split_part(split_part(storage_file.url, '?', 1), '#', 1)
          )
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(asset.video_urls) = 'array'
                THEN asset.video_urls ELSE '[]'::jsonb END
            ) AS media(value)
            WHERE split_part(split_part(media.value, '?', 1), '#', 1)
              = split_part(split_part(storage_file.url, '?', 1), '#', 1)
          )
          OR position(
            split_part(split_part(storage_file.url, '?', 1), '#', 1)
            IN COALESCE(asset.content, '')
          ) > 0
        )
      ORDER BY storage_file.id, asset.updated_at DESC, asset.id DESC
    )
    UPDATE storage_files AS storage_file
    SET reference_type = 'content_asset',
        reference_id = matches.asset_id::text,
        metadata = COALESCE(storage_file.metadata, '{}'::jsonb)
          || jsonb_build_object('contentAssetReferenceBackfill139', true),
        updated_at = NOW()
    FROM matches
    WHERE storage_file.id = matches.storage_file_id;
  `);
}

export async function down(client) {
  await client.query(`
    UPDATE storage_files
    SET reference_type = NULL,
        reference_id = NULL,
        metadata = COALESCE(metadata, '{}'::jsonb) - 'contentAssetReferenceBackfill139',
        updated_at = NOW()
    WHERE metadata->>'contentAssetReferenceBackfill139' = 'true'
      AND reference_type = 'content_asset';
  `);
}
