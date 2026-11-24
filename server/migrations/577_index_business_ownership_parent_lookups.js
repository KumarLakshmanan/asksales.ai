// Keep the ownership checks and their exact text comparisons, but let PostgreSQL
// use native integer/UUID indexes before evaluating those comparisons under RLS.
const legacy = "match_sql:=match_sql||format('%I::text=%L',link->'parent_columns'->>idx,row_data->>(link->'child_columns'->>idx));";
const indexed = `-- ownership_indexed_prefilter_v1
        DECLARE
          key_oid oid;
          key_type text;
          original_predicate text := format('%I::text=%L',link->'parent_columns'->>idx,row_data->>(link->'child_columns'->>idx));
        BEGIN
          SELECT a.atttypid,pg_catalog.format_type(a.atttypid,NULL)
            INTO key_oid,key_type
            FROM pg_catalog.pg_attribute a
            WHERE a.attrelid=pg_catalog.to_regclass(format('%I',link->>'parent'))
              AND a.attname=link->'parent_columns'->>idx
              AND a.attnum>0 AND NOT a.attisdropped;
          IF key_oid IN (20,21,23,2950) THEN
            match_sql:=match_sql||format('(%I=%L::%s AND %s)',link->'parent_columns'->>idx,row_data->>(link->'child_columns'->>idx),key_type,original_predicate);
          ELSE
            match_sql:=match_sql||original_predicate;
          END IF;
        END;`;

async function replacePredicate(client, from, to) {
  const { rows } = await client.query("SELECT pg_get_functiondef('public.enforce_business_ownership()'::regprocedure) AS definition");
  const definition = rows[0]?.definition;
  if (typeof definition !== 'string') throw new Error('Business ownership guard is missing');
  if (definition.includes(to) && !definition.includes(from)) return;
  if (definition.split(from).length !== 2 || definition.includes(to)) {
    throw new Error('Business ownership guard changed; refusing an unreviewed replacement');
  }
  await client.query(definition.replace(from, to));
}

export async function up(client) { await replacePredicate(client, legacy, indexed); }
export async function down(client) { await replacePredicate(client, indexed, legacy); }
