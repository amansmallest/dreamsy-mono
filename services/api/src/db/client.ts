import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";

/** Works for both postgres-js (prod) and PGlite (tests). */
export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

export async function connectPostgres(url: string): Promise<DB> {
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const postgres = (await import("postgres")).default;
  return drizzle(postgres(url, { max: 10 }), { schema }) as unknown as DB;
}

export { schema };
