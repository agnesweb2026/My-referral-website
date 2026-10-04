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

function makeWithdrawalId() {
  return (
    "wd_" +
    Date.now().toString(36) +
    "_" +
    Math.random()
      .toString(36)
      .slice(2, 10)
  );
}

function mapRequest(row) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    username: row.username || "",
    name: row.name || "",
    referral: row.referral || "",
    mpesaNumber:
      row.mpesa_number ||
      row.phone ||
      "",
    amount: Number(row.amount || 0),
    status: normalizeStatus(row.status),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    processedAt: row.processed_at || null
  };
}


/* =========================================================
   DATABASE SETUP / REPAIR
   ========================================================= */

async function ensureWithdrawalTable() {

  /*
    IMPORTANT:
    We DO NOT delete or replace the existing table.

    Your existing database already has withdrawal data.
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id VARCHAR(100) PRIMARY KEY,
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


  /* =======================================================
     ADD MISSING COLUMNS
     ======================================================= */

  await pool.query(`
    ALTER TABLE withdrawal_requests
    ADD COLUMN IF NOT EXISTS employee_id VARCHAR(100);
  `);

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


  /* =======================================================
     INDEXES
     ======================================================= */

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
}


/* =========================================================
   MAIN HANDLER
   ========================================================= */

module.exports = async function handler(req, res) {

  try {

    await ensureWithdrawalTable();


    /* =====================================================
       GET
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
       POST - NEW WITHDRAWAL
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


      /* ===================================================
         VALIDATION
         =================================================== */

      if (!employeeId) {

        return sendJson(res, 400, {
          success: false,
          error: "Missing employeeId"
        });

      }


      if (!mpesaNumber) {

        return sendJson(res, 400, {
          success: false,
          error: "Missing M-PESA number"
        });

      }


      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {

        return sendJson(res, 400, {
          success: false,
          error: "Invalid withdrawal amount"
        });

      }


      /* ===================================================
         CHECK EXISTING PENDING REQUEST
         =================================================== */

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
            AND UPPER(
              CAST(status AS TEXT)
            ) = 'PENDING'
          LIMIT 1
          `,
          [
            employeeId
          ]
        );


      if (
        pendingCheck.rows.length > 0
      ) {

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


      /* ===================================================
         CREATE UNIQUE TEXT ID
         =================================================== */

      let withdrawalId =
        makeWithdrawalId();


      /*
        Extremely unlikely collision protection.
      */

      for (let attempt = 0; attempt < 5; attempt++) {

        const existingId =
          await pool.query(
            `
            SELECT id
            FROM withdrawal_requests
            WHERE CAST(id AS TEXT) = $1::text
            LIMIT 1
            `,
            [
              withdrawalId
            ]
          );


        if (
          existingId.rows.length === 0
        ) {

          break;

        }


        withdrawalId =
          makeWithdrawalId();

      }


      /* ===================================================
         INSERT
         =================================================== */

      const insertResult =
        await pool.query(
          `
          INSERT INTO withdrawal_requests (
            id,
            employee_id,
            username,
            name,
            referral,
            mpesa_number,
            amount,
            status,
            created_at,
            updated_at
          )
          VALUES (
            $1::varchar,
            $2::varchar,
            $3::varchar,
            $4::varchar,
            $5::varchar,
            $6::varchar,
            $7::numeric,
            'PENDING',
            NOW(),
            NOW()
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
            withdrawalId,
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
       PUT - APPROVE / REJECT
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


      /* ===================================================
         VALIDATE ID
         =================================================== */

      if (!requestId) {

        return sendJson(res, 400, {

          success: false,

          error:
            "Missing withdrawal request id"

        });

      }


      /* ===================================================
         VALIDATE STATUS
         =================================================== */

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


      /* ===================================================
         UPDATE ONLY PENDING REQUEST
         =================================================== */

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

            AND UPPER(
              CAST(status AS TEXT)
            ) = 'PENDING'

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
         UPDATE DID NOT HAPPEN
         =================================================== */

      if (
        updateResult.rows.length === 0
      ) {


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
            WHERE
              CAST(id AS TEXT) = $1::text
            LIMIT 1
            `,
            [
              requestId
            ]
          );


        /* Request doesn't exist */

        if (
          existingResult.rows.length === 0
        ) {

          return sendJson(res, 404, {

            success: false,

            error:
              "Withdrawal request not found."

          });

        }


        /* Already processed */

        return sendJson(res, 409, {

          success: false,

          error:
            "This withdrawal request has already been processed.",

          request:
            mapRequest(
              existingResult.rows[0]
            )

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
       OTHER METHODS
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


    /* Duplicate key */

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
