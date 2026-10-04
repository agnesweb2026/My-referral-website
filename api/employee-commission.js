const { Pool } = require("pg");

const connectionString =
  process.env.NEON_DATABASE_URL ||
  process.env.DATABASE_URL ||
  process.env.NEON_POSTGRES_URL;

if (!connectionString) {
  throw new Error("Neon database connection is not configured.");
}

const pool = new Pool({
  connectionString,
  ssl: connectionString.includes("sslmode=require")
    ? undefined
    : {
        rejectUnauthorized: false
      }
});

const COMMISSION_RATE = 0.40;

/*
=========================================
VALID EMPLOYEE REFERRALS
=========================================
*/

const EMPLOYEES = {
  "REF-A7K2": "Joshua1",
  "REF-B4M8": "Joshua2",
  "REF-C9P3": "Joshua3",
  "REF-D2X6": "Joshua4",
  "REF-E5Q1": "Joshua5",
  "REF-F8L4": "Joshua6",
  "REF-G3N7": "Joshua7",
  "REF-H6R2": "Joshua8",
  "REF-J9T5": "Joshua9",
  "REF-K4W8": "Joshua10"
};


/*
=========================================
CREATE COMMISSION TABLE
=========================================
*/

async function ensureCommissionTable() {

  await pool.query(`
    CREATE TABLE IF NOT EXISTS employee_commissions (

      id BIGSERIAL PRIMARY KEY,

      transaction_id VARCHAR(150) NOT NULL UNIQUE,

      reference VARCHAR(100),

      employee_id VARCHAR(100) NOT NULL,

      username VARCHAR(100) NOT NULL,

      payment_amount NUMERIC(12,2) NOT NULL,

      commission_rate NUMERIC(5,4) NOT NULL DEFAULT 0.40,

      commission_amount NUMERIC(12,2) NOT NULL,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()

    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    employee_commissions_employee_idx
    ON employee_commissions(employee_id);
  `);
}


/*
=========================================
JSON RESPONSE
=========================================
*/

function json(res, status, data) {

  res.status(status);

  res.setHeader(
    "Content-Type",
    "application/json"
  );

  return res.end(
    JSON.stringify(data)
  );
}


/*
=========================================
MAIN API
=========================================
*/

module.exports = async function handler(req, res) {

  if (req.method !== "POST") {

    return json(res, 405, {
      success: false,
      message: "Method not allowed."
    });

  }


  try {

    await ensureCommissionTable();


    const body =
      req.body || {};


    const transactionId =
      String(
        body.transaction_id ||
        body.transaction_request_id ||
        ""
      ).trim();


    const employeeId =
      String(
        body.employeeId ||
        body.referral ||
        ""
      ).trim();


    /*
    =====================================
    VALIDATE TRANSACTION
    =====================================
    */

    if (!transactionId) {

      return json(res, 400, {
        success: false,
        message:
          "Missing transaction ID."
      });

    }


    /*
    =====================================
    VALIDATE EMPLOYEE
    =====================================
    */

    const username =
      EMPLOYEES[employeeId];


    if (!username) {

      return json(res, 400, {
        success: false,
        message:
          "Invalid employee referral."
      });

    }


    /*
    =====================================
    FIND COMPLETED PAYMENT
    =====================================
    */

    const paymentResult =
      await pool.query(
        `
        SELECT
          reference,
          amount,
          status,
          transaction_request_id,
          transaction_id
        FROM payments
        WHERE
          (
            transaction_request_id = $1
            OR transaction_id = $1
          )
          AND LOWER(status) IN
          (
            'completed',
            'complete',
            'paid',
            'successful',
            'success'
          )
        ORDER BY updated_at DESC
        LIMIT 1
        `,
        [transactionId]
      );


    if (
      paymentResult.rows.length === 0
    ) {

      return json(res, 409, {
        success: false,
        message:
          "Payment is not confirmed."
      });

    }


    const payment =
      paymentResult.rows[0];


    const paymentAmount =
      Number(
        payment.amount
      );


    if (
      !Number.isFinite(paymentAmount) ||
      paymentAmount <= 0
    ) {

      return json(res, 400, {
        success: false,
        message:
          "Invalid payment amount."
      });

    }


    /*
    =====================================
    CALCULATE 40%
    =====================================
    */

    const commissionAmount =
      Math.round(
        paymentAmount *
        COMMISSION_RATE *
        100
      ) / 100;


    /*
    =====================================
    INSERT COMMISSION
    =====================================

    transaction_id is UNIQUE.

    Therefore the same payment
    cannot create commission twice.
    =====================================
    */

    try {

      const insertResult =
        await pool.query(
          `
          INSERT INTO employee_commissions
          (
            transaction_id,
            reference,
            employee_id,
            username,
            payment_amount,
            commission_rate,
            commission_amount
          )
          VALUES
          ($1,$2,$3,$4,$5,$6,$7)

          RETURNING
            id,
            transaction_id,
            reference,
            employee_id,
            username,
            payment_amount,
            commission_rate,
            commission_amount,
            created_at
          `,
          [
            transactionId,
            payment.reference || null,
            employeeId,
            username,
            paymentAmount,
            COMMISSION_RATE,
            commissionAmount
          ]
        );


      return json(res, 201, {
        success: true,
        duplicate: false,
        commission:
          insertResult.rows[0]
      });


    } catch (insertError) {

      /*
      ==================================
      DUPLICATE COMMISSION
      ==================================
      */

      if (
        insertError &&
        insertError.code === "23505"
      ) {

        const existing =
          await pool.query(
            `
            SELECT
              id,
              transaction_id,
              reference,
              employee_id,
              username,
              payment_amount,
              commission_rate,
              commission_amount,
              created_at
            FROM employee_commissions
            WHERE transaction_id = $1
            LIMIT 1
            `,
            [transactionId]
          );


        return json(res, 200, {
          success: true,
          duplicate: true,
          commission:
            existing.rows[0] || null
        });

      }


      throw insertError;

    }


  } catch (error) {

    console.error(
      "EMPLOYEE COMMISSION ERROR:",
      error
    );


    return json(res, 500, {
      success: false,
      message:
        "Could not record employee commission."
    });

  }

};
