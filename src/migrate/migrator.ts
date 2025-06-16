import type { Pool } from "pg";
import { getMigrationSQL } from "./schema.js";

export async function migrate(pool: Pool, schema: string): Promise<void> {
  const sql = getMigrationSQL(schema);
  await pool.query(sql);
}
