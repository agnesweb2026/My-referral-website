const { Pool } = require("pg");

const connectionString =
  process.env.NEON_DATABASE_URL ||
  process.env.NEON_POSTGRES_URL ||
  process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("Database is not configured.");
}

const poolConfig = {
  connectionString
};

if (!connectionString.includes("sslmode=")) {
  poolConfig.ssl = {
    rejectUnauthorized: false
  };
}

const pool = new Pool(poolConfig);


/* =========================================================
   HELPERS
   ========================================================= */

function sendJson(res, status, data) {
  return res.status(status).json(data);
}

function normalizeStatus(status) {
  return String(status || "")
    .trim()
    .toUpperCase();
}

function mapRequest(row) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    username: row.username || "",
    name: row.name || "",
    referral: row.referral || "",
    mpesaNumber: row.mpesa_number || "",
    amount: Number(row.amount || 0),
    status: normalizeStatus(row.status),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    processedAt: row.processed_at || null
  };
}


/* =========================================================
   CREATE / REPAIR TABLE
   ========================================================= */

async function ensureWithdrawalTable() {

  /*
    Do NOT delete the existing table.

    We keep all existing withdrawal records.
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id BIGSERIAL PRIMARY KEY,
      employee_id VARCHAR(100) NOT NULL,
      username VARCHAR(100),
      name VARCHAR(150),
      referral VARCHAR(100),
      mpesa_number VARCHAR(30),
      amount NUMERIC(12,2),
      status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ
    );
  `);


  /* Missing columns from older table versions */

  await pool.query(`
    ALTER TABLE withdrawal_requests
    ADD COLUMN IF NOT EXISTS username VARCHAR(100);
  `);

  await pool.query(`
    ALTER TABLE withdrawal_requests
    ADD COLUMN IF NOT EXISTS name VARCHAR(150);
  `);

  await pool.query(`
    ALTER TABLE withdrawal_requests
    ADD COLUMN IF NOT EXISTS referral VARCHAR(100);
  `);

  await pool.query(`
    ALTER TABLE withdrawal_requests
    ADD COLUMN IF NOT EXISTS mpesa_number VARCHAR(30);
  `);

  await pool.query(`
    ALTER TABLE withdrawal_requests
    ADD COLUMN IF NOT EXISTS amount NUMERIC(12,2);
  `);

  await pool.query(`
    ALTER TABLE withdrawal_requests
    ADD COLUMN IF NOT EXISTS status VARCHAR(20)
    DEFAULT 'PENDING';
  `);

  await pool.query(`
    ALTER TABLE withdrawal_requests
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ
    DEFAULT NOW();
  `);

  await pool.query(`
    ALTER TABLE withdrawal_requests
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ
    DEFAULT NOW();
  `);

  await pool.query(`
    ALTER TABLE withdrawal_requests
    ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
  `);


  /* Indexes */

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    withdrawal_requests_employee_idx
    ON withdrawal_requests(employee_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    withdrawal_requests_status_idx
    ON withdrawal_requests(status);
  `);


  /*
    We intentionally do NOT create another ID constraint here.

    Your existing database may use VARCHAR for id.
    The API below therefore treats request IDs as TEXT.
  */
}


/* =========================================================
   MAIN HANDLER
   ========================================================= */

module.exports = async function handler(req, res) {

  try {

    await ensureWithdrawalTable();


    /* =====================================================
       GET REQUESTS
       ===================================================== */

    if (req.method === "GET") {

      const result = await pool.query(`
        SELECT
          id,
          employee_id,
          username,
          name,
          referral,
          mpesa_number,
          amount,
          status,
          created_at,
          updated_at,
          processed_at
        FROM withdrawal_requests
        ORDER BY created_at DESC
      `);

      return sendJson(res, 200, {
        success: true,
        requests: result.rows.map(mapRequest)
      });
    }


    /* =====================================================
       CREATE WITHDRAWAL REQUEST
       ===================================================== */

    if (req.method === "POST") {

      const body = req.body || {};

      const employeeId =
        String(
          body.employeeId || ""
        ).trim();

      const username =
        String(
          body.username || ""
        ).trim();

      const name =
        String(
          body.name || ""
        ).trim();

      const referral =
        String(
          body.referral || ""
        ).trim();

      const mpesaNumber =
        String(
          body.mpesaNumber ||
          body.mpesa ||
          body.phone ||
          ""
        ).trim();

      const amount =
        Number(body.amount);


      /* Validate employee */

      if (!employeeId) {

        return sendJson(res, 400, {
          success: false,
          error: "Missing employeeId"
        });

      }


      /* Validate M-PESA */

      if (!mpesaNumber) {

        return sendJson(res, 400, {
          success: false,
          error: "Missing M-PESA number"
        });

      }


      /* Validate amount */

      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {

        return sendJson(res, 400, {
          success: false,
          error: "Invalid withdrawal amount"
        });

      }


      /* Check pending request */

      const pendingCheck =
        await pool.query(
          `
          SELECT
            id,
            employee_id,
            username,
            name,
            referral,
            mpesa_number,
            amount,
            status,
            created_at,
            updated_at,
            processed_at
          FROM withdrawal_requests
          WHERE
            employee_id = $1::varchar
            AND UPPER(CAST(status AS TEXT)) = 'PENDING'
          LIMIT 1
          `,
          [
            employeeId
          ]
        );


      if (pendingCheck.rows.length > 0) {

        return sendJson(res, 409, {
          success: false,
          error:
            "You already have a pending withdrawal request.",
          request:
            mapRequest(
              pendingCheck.rows[0]
            )
        });

      }


      /* Insert request */

      const insertResult =
        await pool.query(
          `
          INSERT INTO withdrawal_requests (
            employee_id,
            username,
            name,
            referral,
            mpesa_number,
            amount,
            status
          )
          VALUES (
            $1::varchar,
            $2::varchar,
            $3::varchar,
            $4::varchar,
            $5::varchar,
            $6::numeric,
            'PENDING'
          )
          RETURNING
            id,
            employee_id,
            username,
            name,
            referral,
            mpesa_number,
            amount,
            status,
            created_at,
            updated_at,
            processed_at
          `,
          [
            employeeId,
            username || null,
            name || null,
            referral || null,
            mpesaNumber,
            amount
          ]
        );


      return sendJson(res, 201, {

        success: true,

        message:
          "Withdrawal request submitted successfully.",

        request:
          mapRequest(
            insertResult.rows[0]
          )

      });

    }


    /* =====================================================
       APPROVE / REJECT
       ===================================================== */

    if (req.method === "PUT") {

      const body = req.body || {};

      const requestId =
        String(
          body.id ||
          body.requestId ||
          ""
        ).trim();

      const requestedStatus =
        normalizeStatus(
          body.status
        );


      /* Validate ID */

      if (!requestId) {

        return sendJson(res, 400, {
          success: false,
          error:
            "Missing withdrawal request id"
        });

      }


      /* Validate status */

      if (
        requestedStatus !== "APPROVED" &&
        requestedStatus !== "REJECTED"
      ) {

        return sendJson(res, 400, {
          success: false,
          error:
            "Status must be APPROVED or REJECTED"
        });

      }


      /*
        IMPORTANT:

        We compare the existing ID as TEXT.

        This fixes:
        character varying = bigint

        It also works with old VARCHAR IDs.
      */

      const updateResult =
        await pool.query(
          `
          UPDATE withdrawal_requests
          SET
            status = $1::varchar,
            updated_at = NOW(),
            processed_at = NOW()
          WHERE
            CAST(id AS TEXT) = $2::text
            AND UPPER(CAST(status AS TEXT)) = 'PENDING'
          RETURNING
            id,
            employee_id,
            username,
            name,
            referral,
            mpesa_number,
            amount,
            status,
            created_at,
            updated_at,
            processed_at
          `,
          [
            requestedStatus,
            requestId
          ]
        );


      /* ===================================================
         UPDATE FAILED
         =================================================== */

      if (
        updateResult.rows.length === 0
      ) {

        /*
          Check whether the request exists.
        */

        const existingResult =
          await pool.query(
            `
            SELECT
              id,
              employee_id,
              username,
              name,
              referral,
              mpesa_number,
              amount,
              status,
              created_at,
              updated_at,
              processed_at
            FROM withdrawal_requests
            WHERE CAST(id AS TEXT) = $1::text
            LIMIT 1
            `,
            [
              requestId
            ]
          );


        /*
          Request does not exist.
        */

        if (
          existingResult.rows.length === 0
        ) {

          return sendJson(res, 404, {
            success: false,
            error:
              "Withdrawal request not found."
          });

        }


        /*
          Request exists but is no longer pending.
        */

        const existing =
          existingResult.rows[0];


        return sendJson(res, 409, {

          success: false,

          error:
            "This withdrawal request has already been processed.",

          request:
            mapRequest(existing)

        });

      }


      /* ===================================================
         SUCCESS
         =================================================== */

      const updated =
        updateResult.rows[0];


      return sendJson(res, 200, {

        success: true,

        message:
          requestedStatus === "APPROVED"
            ? "Withdrawal approved successfully."
            : "Withdrawal rejected successfully.",

        request:
          mapRequest(updated)

      });

    }


    /* =====================================================
       METHOD NOT ALLOWED
       ===================================================== */

    return sendJson(res, 405, {

      success: false,

      error:
        "Method not allowed"

    });


  } catch (error) {

    console.error(
      "Withdrawal API error:",
      error
    );


    /*
      PostgreSQL duplicate constraint
    */

    if (
      error &&
      error.code === "23505"
    ) {

      return sendJson(res, 409, {

        success: false,

        error:
          "You already have a pending withdrawal request."

      });

    }


    return sendJson(res, 500, {

      success: false,

      error:
        "Server error while processing withdrawal."

    });

  }

};
