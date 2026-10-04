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
    Math.random().toString(36).slice(2, 10)
  );
}


/* =========================================================
   MAP REQUEST
========================================================= */

function mapRequest(row) {

  const employeeName =
    row.employee_name ||
    row.name ||
    row.username ||
    "Employee";

  const phone =
    row.phone ||
    row.mpesa_number ||
    "";

  return {

    id: String(row.id || ""),

    employeeId:
      String(row.employee_id || ""),

    username:
      row.username || "",

    name:
      employeeName,

    employeeName:
      employeeName,

    referral:
      row.referral || "",

    phone:
      phone,

    mpesaNumber:
      phone,

    amount:
      Number(row.amount || 0),

    status:
      normalizeStatus(row.status),

    createdAt:
      row.created_at || null,

    updatedAt:
      row.updated_at || null,

    processedAt:
      row.processed_at || null
  };
}


/* =========================================================
   DATABASE SETUP
========================================================= */

async function ensureWithdrawalTable() {

  await pool.query(`
    CREATE TABLE IF NOT EXISTS withdrawal_requests (

      id VARCHAR(100) PRIMARY KEY,

      employee_id VARCHAR(100) NOT NULL,

      employee_name VARCHAR(150) NOT NULL,

      username VARCHAR(100),

      name VARCHAR(150),

      referral VARCHAR(100),

      phone VARCHAR(30) NOT NULL,

      mpesa_number VARCHAR(30),

      amount NUMERIC(12,2),

      status VARCHAR(20)
        NOT NULL
        DEFAULT 'PENDING',

      created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      processed_at TIMESTAMPTZ
    );
  `);


  /* =======================================================
     ADD COLUMNS IF MISSING
  ======================================================= */

  await pool.query(`
    ALTER TABLE withdrawal_requests
    ADD COLUMN IF NOT EXISTS employee_id VARCHAR(100);
  `);

  await pool.query(`
    ALTER TABLE withdrawal_requests
    ADD COLUMN IF NOT EXISTS employee_name VARCHAR(150);
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
    ADD COLUMN IF NOT EXISTS phone VARCHAR(30);
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
     REPAIR EXISTING ROWS
  ======================================================= */

  await pool.query(`
    UPDATE withdrawal_requests
    SET employee_name =
      COALESCE(
        NULLIF(employee_name, ''),
        NULLIF(name, ''),
        NULLIF(username, ''),
        'Employee'
      )
    WHERE employee_name IS NULL
       OR employee_name = '';
  `);


  await pool.query(`
    UPDATE withdrawal_requests
    SET phone =
      COALESCE(
        NULLIF(phone, ''),
        NULLIF(mpesa_number, ''),
        ''
      )
    WHERE phone IS NULL;
  `);


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

      const result =
        await pool.query(`
          SELECT
            id,
            employee_id,
            employee_name,
            username,
            name,
            referral,
            phone,
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

        requests:
          result.rows.map(mapRequest)

      });
    }


    /* =====================================================
       POST
    ===================================================== */

    if (req.method === "POST") {

      const body =
        req.body || {};


      const employeeId =
        String(
          body.employeeId ||
          body.employee_id ||
          body.id ||
          ""
        ).trim();


      const username =
        String(
          body.username ||
          ""
        ).trim();


      const employeeName =
        String(
          body.employeeName ||
          body.employee_name ||
          body.name ||
          username ||
          "Employee"
        ).trim();


      const referral =
        String(
          body.referral ||
          ""
        ).trim();


      const phone =
        String(
          body.phone ||
          body.mpesaNumber ||
          body.mpesa ||
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

          error:
            "Missing employeeId"

        });
      }


      if (!phone) {

        return sendJson(res, 400, {

          success: false,

          error:
            "Missing M-PESA number"

        });
      }


      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {

        return sendJson(res, 400, {

          success: false,

          error:
            "Invalid withdrawal amount"

        });
      }


      /* ===================================================
         CHECK PENDING
      =================================================== */

      const pendingCheck =
        await pool.query(
          `
          SELECT
            id,
            employee_id,
            employee_name,
            username,
            name,
            referral,
            phone,
            mpesa_number,
            amount,
            status,
            created_at,
            updated_at,
            processed_at

          FROM withdrawal_requests

          WHERE
            CAST(employee_id AS TEXT)
            = $1::text

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
         UNIQUE ID
      =================================================== */

      let withdrawalId =
        makeWithdrawalId();


      for (
        let attempt = 0;
        attempt < 5;
        attempt++
      ) {

        const existing =
          await pool.query(
            `
            SELECT id

            FROM withdrawal_requests

            WHERE
              CAST(id AS TEXT)
              = $1::text

            LIMIT 1
            `,
            [
              withdrawalId
            ]
          );


        if (
          existing.rows.length === 0
        ) {

          break;
        }


        withdrawalId =
          makeWithdrawalId();
      }


      /* ===================================================
         INSERT
         
         IMPORTANT:
         We now save BOTH phone and mpesa_number.
      =================================================== */

      const insertResult =
        await pool.query(
          `
          INSERT INTO withdrawal_requests (

            id,

            employee_id,

            employee_name,

            username,

            name,

            referral,

            phone,

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

            $7::varchar,

            $8::varchar,

            $9::numeric,

            'PENDING',

            NOW(),

            NOW()

          )

          RETURNING

            id,

            employee_id,

            employee_name,

            username,

            name,

            referral,

            phone,

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

            employeeName,

            username || null,

            employeeName,

            referral || null,

            phone,

            phone,

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
       PUT - ADMIN APPROVE / REJECT
    ===================================================== */

    if (req.method === "PUT") {

      const body =
        req.body || {};


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

          error:
            "Missing withdrawal request id"

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


      /* ===================================================
         ONLY PENDING CAN BE PROCESSED
      =================================================== */

      const updateResult =
        await pool.query(
          `
          UPDATE withdrawal_requests

          SET

            status =
              $1::varchar,

            updated_at =
              NOW(),

            processed_at =
              NOW()

          WHERE

            CAST(id AS TEXT)
            = $2::text

            AND UPPER(
              CAST(status AS TEXT)
            ) = 'PENDING'

          RETURNING

            id,

            employee_id,

            employee_name,

            username,

            name,

            referral,

            phone,

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
         ALREADY PROCESSED / NOT FOUND
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

              employee_name,

              username,

              name,

              referral,

              phone,

              mpesa_number,

              amount,

              status,

              created_at,

              updated_at,

              processed_at

            FROM withdrawal_requests

            WHERE

              CAST(id AS TEXT)
              = $1::text

            LIMIT 1
            `,
            [
              requestId
            ]
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


    /* =====================================================
       DUPLICATE
    ===================================================== */

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


    /* =====================================================
       DATABASE CONSTRAINT ERROR
    ===================================================== */

    if (
      error &&
      error.code === "23502"
    ) {

      return sendJson(res, 500, {

        success: false,

        error:
          "Database requires a missing withdrawal field.",

        detail:
          error.column || null

      });
    }


    /* =====================================================
       GENERAL ERROR
    ===================================================== */

    return sendJson(res, 500, {

      success: false,

      error:
        "Server error while processing withdrawal."

    });
  }
};
