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
    username: row.username,
    name: row.name,
    referral: row.referral,
    mpesaNumber: row.mpesa_number,
    amount: Number(row.amount || 0),
    status: normalizeStatus(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    processedAt: row.processed_at
  };
}


/* =========================================================
   DATABASE TABLE
========================================================= */

async function ensureWithdrawalTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id BIGSERIAL PRIMARY KEY,

      employee_id VARCHAR(100) NOT NULL,

      username VARCHAR(100),

      name VARCHAR(150),

      referral VARCHAR(100),

      mpesa_number VARCHAR(30) NOT NULL,

      amount NUMERIC(12,2) NOT NULL,

      status VARCHAR(20) NOT NULL DEFAULT 'PENDING',

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      processed_at TIMESTAMPTZ
    );
  `);


  await pool.query(`
    CREATE INDEX IF NOT EXISTS withdrawal_requests_employee_idx
    ON withdrawal_requests(employee_id);
  `);


  await pool.query(`
    CREATE INDEX IF NOT EXISTS withdrawal_requests_status_idx
    ON withdrawal_requests(status);
  `);


  /*
    Only ONE pending withdrawal per employee.
  */
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
    withdrawal_one_pending_per_employee_idx
    ON withdrawal_requests(employee_id)
    WHERE status = 'PENDING';
  `);
}


/* =========================================================
   MAIN HANDLER
========================================================= */

module.exports = async function handler(req, res) {

  try {

    await ensureWithdrawalTable();


    /* =====================================================
       GET WITHDRAWAL REQUESTS
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
       POST NEW WITHDRAWAL REQUEST
    ===================================================== */

    if (req.method === "POST") {

      const body = req.body || {};


      const employeeId =
        String(body.employeeId || "")
          .trim();


      const username =
        String(body.username || "")
          .trim();


      const name =
        String(body.name || "")
          .trim();


      const referral =
        String(body.referral || "")
          .trim();


      const mpesaNumber =
        String(
          body.mpesaNumber ||
          body.mpesa ||
          body.phone ||
          ""
        ).trim();


      const amount =
        Number(body.amount);


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


      /*
        Check if employee already has
        a pending request.
      */

      const pendingCheck =
        await pool.query(
          `
          SELECT
            id,
            amount,
            status
          FROM withdrawal_requests
          WHERE
            employee_id = $1::varchar
            AND status = 'PENDING'
          LIMIT 1
          `,
          [employeeId]
        );


      if (pendingCheck.rows.length > 0) {

        return sendJson(res, 409, {
          success: false,
          error:
            "You already have a pending withdrawal request."
        });
      }


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
          mapRequest(insertResult.rows[0])
      });
    }


    /* =====================================================
       UPDATE WITHDRAWAL
       ADMIN APPROVE / REJECT
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


      if (!requestId) {
        return sendJson(res, 400, {
          success: false,
          error: "Missing withdrawal request id"
        });
      }


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

        We update ONLY a PENDING request.

        This prevents the same withdrawal
        from being approved/deducted twice.
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
            id = $2::bigint
            AND status = 'PENDING'::varchar
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


      /*
        No row means:

        - request does not exist
        OR
        - request was already processed
      */

      if (updateResult.rows.length === 0) {

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
            WHERE id = $1::bigint
            LIMIT 1
            `,
            [requestId]
          );


        if (
          existingResult.rows.length === 0
        ) {
          return sendJson(res, 404, {
            success: false,
            error:
              "Withdrawal request not found."
          });
        }


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


      const updated =
        updateResult.rows[0];


      /*
        IMPORTANT:

        Balance is NOT stored here.

        The employee dashboard calculates:

        Available Balance =
        Total Commission -
        APPROVED Withdrawals

        Therefore:

        PENDING  = balance unchanged
        REJECTED = balance unchanged
        APPROVED = balance reduced
      */

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
      error: "Method not allowed"
    });


  } catch (error) {

    console.error(
      "Withdrawal API error:",
      error
    );


    /*
      Duplicate pending request can happen
      because of the unique partial index.
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
