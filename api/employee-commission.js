const { pool } = require("./employee-db");

const COMMISSION_RATE = 0.40;

function sendJson(res, status, data) {
  res.status(status).json(data);
}

async function ensureCommissionTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employee_commissions (
      id BIGSERIAL PRIMARY KEY,

      transaction_id VARCHAR(150) UNIQUE NOT NULL,

      reference VARCHAR(100),

      employee_id VARCHAR(100) NOT NULL,

      username VARCHAR(100),

      referral VARCHAR(100) NOT NULL,

      payment_amount NUMERIC(12,2) NOT NULL,

      commission_rate NUMERIC(5,4) NOT NULL DEFAULT 0.40,

      commission_amount NUMERIC(12,2) NOT NULL,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS employee_commissions_employee_idx
    ON employee_commissions(employee_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS employee_commissions_referral_idx
    ON employee_commissions(referral);
  `);
}

module.exports = async function handler(req, res) {

  if (req.method !== "POST") {
    return sendJson(res, 405, {
      success: false,
      error: "Method not allowed"
    });
  }

  try {

    await ensureCommissionTable();

    const body = req.body || {};

    const transactionId =
      String(body.transaction_id || "").trim();

    const employeeId =
      String(body.employeeId || "").trim();

    const referral =
      String(body.referral || "").trim();

    const username =
      String(body.username || "").trim();

    if (!transactionId) {
      return sendJson(res, 400, {
        success: false,
        error: "Missing transaction_id"
      });
    }

    if (!employeeId) {
      return sendJson(res, 400, {
        success: false,
        error: "Missing employeeId"
      });
    }

    if (!referral) {
      return sendJson(res, 400, {
        success: false,
        error: "Missing referral"
      });
    }

    /*
     * IMPORTANT:
     * We get the payment amount from the payments table.
     * We DO NOT trust an amount sent by the browser.
     */

    const paymentResult = await pool.query(
      `
      SELECT
        id,
        reference,
        amount,
        status,
        transaction_request_id,
        transaction_id,
        transaction_code
      FROM payments
      WHERE
        transaction_id = $1
        OR transaction_request_id = $1
      ORDER BY updated_at DESC
      LIMIT 1
      `,
      [transactionId]
    );

    if (paymentResult.rows.length === 0) {
      return sendJson(res, 404, {
        success: false,
        error: "Payment was not found"
      });
    }

    const payment = paymentResult.rows[0];

    /*
     * Commission is created ONLY after confirmed payment.
     */

    if (String(payment.status).toLowerCase() !== "completed") {
      return sendJson(res, 400, {
        success: false,
        error: "Payment is not completed yet"
      });
    }

    const paymentAmount =
      Number(payment.amount);

    if (
      !Number.isFinite(paymentAmount) ||
      paymentAmount <= 0
    ) {
      return sendJson(res, 400, {
        success: false,
        error: "Invalid payment amount"
      });
    }

    const commissionAmount =
      Math.round(
        paymentAmount *
        COMMISSION_RATE *
        100
      ) / 100;

    /*
     * UNIQUE transaction_id prevents duplicate commission.
     */

    const insertResult = await pool.query(
      `
      INSERT INTO employee_commissions (
        transaction_id,
        reference,
        employee_id,
        username,
        referral,
        payment_amount,
        commission_rate,
        commission_amount
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8
      )
      ON CONFLICT (transaction_id)
      DO NOTHING
      RETURNING
        id,
        transaction_id,
        employee_id,
        username,
        referral,
        payment_amount,
        commission_rate,
        commission_amount,
        created_at
      `,
      [
        transactionId,
        payment.reference || null,
        employeeId,
        username || null,
        referral,
        paymentAmount,
        COMMISSION_RATE,
        commissionAmount
      ]
    );

    /*
     * Already processed.
     */

    if (insertResult.rows.length === 0) {

      const existingResult = await pool.query(
        `
        SELECT
          id,
          transaction_id,
          employee_id,
          username,
          referral,
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

      return sendJson(res, 200, {
        success: true,
        duplicate: true,
        message: "Commission already recorded",
        commission:
          existingResult.rows[0] || null
      });
    }

    return sendJson(res, 200, {
      success: true,
      duplicate: false,
      message: "40% commission recorded successfully",
      commission: insertResult.rows[0]
    });

  } catch (error) {

    console.error(
      "Employee commission error:",
      error
    );

    return sendJson(res, 500, {
      success: false,
      error: "Failed to process employee commission"
    });
  }
};
