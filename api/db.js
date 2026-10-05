const { Pool } = require("pg");

const connectionString =
  process.env.NEON_POSTGRES_URL_NO_SSL ||
  process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("Database connection is not configured.");
}

const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});


/*
=========================================================
PAYMENT TABLE
=========================================================
*/

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

      transaction_request_id VARCHAR(150),

      transaction_id VARCHAR(150),

      transaction_code VARCHAR(150),

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()
    );
  `);


  /*
  =======================================================
  PAYMENT ABUSE / ATTEMPT TABLE
  =======================================================
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_attempts (

      id BIGSERIAL PRIMARY KEY,

      phone VARCHAR(20)
        NOT NULL,

      ip_address VARCHAR(100),

      reference VARCHAR(100),

      amount INTEGER,

      status VARCHAR(30)
        NOT NULL DEFAULT 'pending',

      transaction_id VARCHAR(150),

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()

    );
  `);


  /*
  =======================================================
  INDEXES
  =======================================================
  */

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    payment_attempts_phone_created_idx
    ON payment_attempts(phone, created_at);
  `);


  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    payment_attempts_ip_created_idx
    ON payment_attempts(ip_address, created_at);
  `);


  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    payment_attempts_status_created_idx
    ON payment_attempts(status, created_at);
  `);

}


/*
=========================================================
DATABASE QUERY HELPER
=========================================================
*/

async function query(text, params) {

  return pool.query(
    text,
    params
  );

}


/*
=========================================================
EXPORTS
=========================================================
*/

module.exports = {
  pool,
  query,
  ensurePaymentTable
};
