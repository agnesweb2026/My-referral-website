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


// ========================================
// HELPERS
// ========================================

function cleanText(value) {
  return String(value ?? "").trim();
}

function validPhone(phone) {
  return /^07\d{8}$/.test(cleanText(phone));
}

function validAmount(amount) {
  const value = Number(amount);

  return (
    Number.isFinite(value) &&
    value > 0
  );
}


// ========================================
// CREATE TABLE
// ========================================

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id VARCHAR(100) PRIMARY KEY,

      employee_name TEXT NOT NULL,

      employee_id TEXT NOT NULL,

      username TEXT NOT NULL,

      referral TEXT NOT NULL,

      amount NUMERIC(12,2) NOT NULL,

      phone VARCHAR(20) NOT NULL,

      status VARCHAR(20)
        NOT NULL
        DEFAULT 'PENDING',

      created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      processed_at TIMESTAMPTZ,

      processed_by TEXT,

      approved_at TIMESTAMPTZ,

      rejected_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS
      withdrawal_requests_employee_status_idx
    ON withdrawal_requests(
      employee_id,
      status
    );

    CREATE UNIQUE INDEX IF NOT EXISTS
      withdrawal_one_pending_per_employee
    ON withdrawal_requests(employee_id)
    WHERE status = 'PENDING';
  `);
}


// ========================================
// DATABASE → FRONTEND FORMAT
// ========================================

function mapRequest(row) {
  return {
    id: row.id,

    employeeName:
      row.employee_name,

    employeeId:
      row.employee_id,

    username:
      row.username,

    referral:
      row.referral,

    amount:
      Number(row.amount),

    phone:
      row.phone,

    status:
      row.status,

    createdAt:
      row.created_at,

    processedAt:
      row.processed_at,

    processedBy:
      row.processed_by,

    approvedAt:
      row.approved_at,

    rejectedAt:
      row.rejected_at
  };
}


// ========================================
// MAIN API
// ========================================

export default async function handler(req, res) {

  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );


  // ======================================
  // OPTIONS
  // ======================================

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }


  try {

    // ====================================
    // MAKE SURE TABLE EXISTS
    // ====================================

    await ensureTable();


    // ====================================
    // GET REQUESTS
    // ====================================

    if (req.method === "GET") {

      const result = await pool.query(`
        SELECT *
        FROM withdrawal_requests
        ORDER BY created_at DESC
      `);

      return res.status(200).json({
        success: true,

        requests:
          result.rows.map(mapRequest)
      });
    }


    // ====================================
    // CREATE WITHDRAWAL REQUEST
    // ====================================

    if (req.method === "POST") {

      const body =
        typeof req.body === "string"
          ? JSON.parse(req.body)
          : req.body || {};


      const employeeName =
        cleanText(
          body.employeeName
        );

      const employeeId =
        cleanText(
          body.employeeId
        );

      const username =
        cleanText(
          body.username
        );

      const referral =
        cleanText(
          body.referral
        );

      const phone =
        cleanText(
          body.phone
        );

      const amount =
        Number(body.amount);


      // ----------------------------------
      // REQUIRED FIELDS
      // ----------------------------------

      if (
        !employeeName ||
        !employeeId ||
        !username ||
        !referral ||
        !phone ||
        !body.amount
      ) {

        return res.status(400).json({
          success: false,

          message:
            "Missing withdrawal information."
        });
      }


      // ----------------------------------
      // VALID AMOUNT
      // ----------------------------------

      if (!validAmount(amount)) {

        return res.status(400).json({
          success: false,

          message:
            "Invalid withdrawal amount."
        });
      }


      // ----------------------------------
      // VALID PHONE
      // ----------------------------------

      if (!validPhone(phone)) {

        return res.status(400).json({
          success: false,

          message:
            "Invalid Kenyan phone number."
        });
      }


      // ----------------------------------
      // UNIQUE REQUEST ID
      // ----------------------------------

      const id =
        "WD-" +
        Date.now() +
        "-" +
        Math.random()
          .toString(36)
          .slice(2, 8);


      try {

        const result =
          await pool.query(
            `
            INSERT INTO withdrawal_requests
            (
              id,
              employee_name,
              employee_id,
              username,
              referral,
              amount,
              phone,
              status
            )

            VALUES
            (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              'PENDING'
            )

            RETURNING *
            `,
            [
              id,
              employeeName,
              employeeId,
              username,
              referral,
              amount,
              phone
            ]
          );


        return res.status(201).json({

          success: true,

          request:
            mapRequest(
              result.rows[0]
            )
        });


      } catch (error) {

        // ==================================
        // DUPLICATE PENDING REQUEST
        // ==================================

        if (
          error &&
          error.code === "23505"
        ) {

          return res.status(409).json({

            success: false,

            message:
              "You already have a pending withdrawal request."
          });
        }

        throw error;
      }
    }


    // ====================================
    // ADMIN APPROVE / REJECT
    // ====================================

    if (req.method === "PUT") {

      const body =
        typeof req.body === "string"
          ? JSON.parse(req.body)
          : req.body || {};


      const id =
        cleanText(
          body.id
        );


      const requestedStatus =
        cleanText(
          body.status
        ).toUpperCase();


      // ----------------------------------
      // REQUIRED
      // ----------------------------------

      if (
        !id ||
        !requestedStatus
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Request ID and status are required."
        });
      }


      // ----------------------------------
      // ONLY APPROVED OR REJECTED
      // ----------------------------------

      if (
        requestedStatus !== "APPROVED" &&
        requestedStatus !== "REJECTED"
      ) {

        return res.status(400).json({

          success: false,

          message:
            "Invalid withdrawal status."
        });
      }


      const processedAt =
        new Date();


      // ==================================
      // IMPORTANT
      //
      // Only PENDING can be changed.
      //
      // This prevents:
      // APPROVED → APPROVED again
      // REJECTED → APPROVED
      // double deduction
      // ==================================

      const result =
        await pool.query(
          `
          UPDATE withdrawal_requests

          SET
            status = $1,

            processed_at = $2,

            processed_by = 'admin',

            approved_at =
              CASE
                WHEN $1 = 'APPROVED'
                THEN $2
                ELSE approved_at
              END,

            rejected_at =
              CASE
                WHEN $1 = 'REJECTED'
                THEN $2
                ELSE rejected_at
              END

          WHERE id = $3

          AND status = 'PENDING'

          RETURNING *
          `,
          [
            requestedStatus,
            processedAt,
            id
          ]
        );


      // ==================================
      // REQUEST NOT UPDATED
      // ==================================

      if (
        !result.rows.length
      ) {

        const existing =
          await pool.query(
            `
            SELECT *
            FROM withdrawal_requests
            WHERE id = $1
            `,
            [id]
          );


        // -------------------------------
        // NOT FOUND
        // -------------------------------

        if (
          !existing.rows.length
        ) {

          return res.status(404).json({

            success: false,

            message:
              "Withdrawal request not found."
          });
        }


        // -------------------------------
        // ALREADY PROCESSED
        // -------------------------------

        return res.status(409).json({

          success: false,

          message:
            "This withdrawal has already been processed.",

          request:
            mapRequest(
              existing.rows[0]
            )
        });
      }


      // ==================================
      // SUCCESS
      // ==================================

      return res.status(200).json({

        success: true,

        request:
          mapRequest(
            result.rows[0]
          )
      });
    }


    // ====================================
    // METHOD NOT ALLOWED
    // ====================================

    return res.status(405).json({

      success: false,

      message:
        "Method not allowed."
    });


  } catch (error) {

    console.error(
      "Withdrawal API error:",
      error
    );


    return res.status(500).json({

      success: false,

      message:
        "Withdrawal server error."
    });
  }
    }
