import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    delete from "assistant_index_asset" raw
    where raw."inventoryKind" = 'raw_file'
      and exists (
        select 1
        from "assistant_index_asset" asset
        where asset."runId" = raw."runId"
          and asset."originalPath" = raw."originalPath"
          and asset."inventoryKind" = 'asset'
      );
  `.execute(db);

  await sql`
    with ranked as (
      select
        id,
        row_number() over (
          partition by "runId", "originalPath"
          order by
            case when "inventoryKind" = 'asset' then 0 else 1 end,
            "createdAt",
            id
        ) as row_number
      from "assistant_index_asset"
    )
    delete from "assistant_index_asset"
    where id in (
      select id
      from ranked
      where row_number > 1
    );
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "assistant_index_asset_runId_originalPath_idx"
    ON "assistant_index_asset" ("runId", "originalPath");
  `.execute(db);
}

export async function down(): Promise<void> {
  // not supported
}
