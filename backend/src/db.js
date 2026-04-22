import { Pool } from "pg";

const pool = new Pool({
  host: process.env.PG_HOST || "localhost",
  port: parseInt(process.env.PG_PORT || "5432"),
  user: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD || "postgres",
  database: process.env.PG_DATABASE || "collab_editor",
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: {
    rejectUnauthorized: false,
  },
});

pool.on("error", (err) => {
  console.error("[DB] Unexpected pool error:", err.message);
});

async function ping() {
  const res = await pool.query("SELECT NOW()");
  return res.rows[0].now;
}

export { pool, ping };
