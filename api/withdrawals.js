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
   CREATE / REPAIR WITHDRAWAL TABLE
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


  /*
    IMPORTANT:

    Older versions of the table may already exist
    without some of the newer columns.

    These commands add only missing columns.
    Existing withdrawal requests are NOT deleted.
  */

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


  /*
    Only ONE pending withdrawal per employee.

    This does NOT block new withdrawals after
    the previous request has been APPROVED or REJECTED.
  */

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
    withdrawal_one_pending_per_employee_idx
    ON withdrawal_requests(employee_id)
    WHERE status = 'PENDING';
  `);
}


/* =========================================================
   MAIN API
   ========================================================= */

module.exports = async function handler(req, res) {

  try {

    /*
      Make sure the table exists and repair any
      missing columns before doing anything else.
    */

    await ensureWithdrawalTable();


    /* =====================================================
       GET
       Admin / Employee loads withdrawal requests
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
       POST
       Employee creates withdrawal request
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


      /* ---------------------------------------------------
         Validate employee
         --------------------------------------------------- */

      if (!employeeId) {

        return sendJson(res, 400, {
          success: false,
          error: "Missing employeeId"
        });

      }


      /* ---------------------------------------------------
         Validate M-PESA number
         --------------------------------------------------- */

      if (!mpesaNumber) {

        return sendJson(res, 400, {
          success: false,
          error: "Missing M-PESA number"
        });

      }


      /* ---------------------------------------------------
         Validate amount
         --------------------------------------------------- */

      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {

        return sendJson(res, 400, {
          success: false,
          error: "Invalid withdrawal amount"
        });

      }


      /* ---------------------------------------------------
         Check existing pending request
         --------------------------------------------------- */

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
            AND status = 'PENDING'::varchar
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
          request: mapRequest({
            id: pendingCheck.rows[0].id,
            employee_id: employeeId,
            username: username,
            name: name,
            referral: referral,
            mpesa_number: mpesaNumber,
            amount: pendingCheck.rows[0].amount,
            status: pendingCheck.rows[0].status
          })
        });

      }


      /* ---------------------------------------------------
         Create withdrawal request
         --------------------------------------------------- */

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
            'PENDING'::varchar
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
       PUT
       Admin approves or rejects withdrawal
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


      /* ---------------------------------------------------
         Validate request ID
         --------------------------------------------------- */

      if (!requestId) {

        return sendJson(res, 400, {
          success: false,
          error:
            "Missing withdrawal request id"
        });

      }


      /* ---------------------------------------------------
         Validate status
         --------------------------------------------------- */

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

        This prevents an already-approved withdrawal
        from being approved a second time.

        Therefore the same withdrawal can NEVER
        deduct the employee balance twice.
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


      /* ---------------------------------------------------
         Request was not updated
         --------------------------------------------------- */

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
            WHERE id = $1::bigint
            LIMIT 1
            `,
            [
              requestId
            ]
          );


        /* -------------------------------------------------
           Request does not exist
           ------------------------------------------------- */

        if (
          existingResult.rows.length === 0
        ) {

          return sendJson(res, 404, {
            success: false,
            error:
              "Withdrawal request not found."
          });

        }


        /* -------------------------------------------------
           Request already processed
           ------------------------------------------------- */

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


      /* ---------------------------------------------------
         Successfully approved / rejected
         --------------------------------------------------- */

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
       Unsupported method
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


    /* -----------------------------------------------------
       Duplicate pending withdrawal
       ----------------------------------------------------- */

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


    /* -----------------------------------------------------
       General server error
       ----------------------------------------------------- */

    return sendJson(res, 500, {

      success: false,

      error:
        "Server error while processing withdrawal."

    });

  }

};
