const { Pool } = require("pg");

const connectionString =
  process.env.NEON_POSTGRES_URL_NO_SSL ||
  process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "Database connection is not configured."
  );
}

const pool = new Pool({
  connectionString,
  ssl: false,
});

async function ensurePaymentTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id BIGSERIAL PRIMARY KEY,

      reference VARCHAR(100)
        UNIQUE NOT NULL,

      amount INTEGER NOT NULL,

      phone VARCHAR(20),

      status VARCHAR(30)
        NOT NULL DEFAULT 'pending',

      transaction_request_id
        VARCHAR(150),

      transaction_id
        VARCHAR(150),

      transaction_code
        VARCHAR(150),

      created_at
        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      updated_at
        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function query(text, params) {
  return pool.query(text, params);
}

module.exports = {
  pool,
  query,
  ensurePaymentTable,
};
