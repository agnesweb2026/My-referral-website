const { pool } = require("./db");

const COMMISSION_RATE = 0.40;

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
}

module.exports = async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  try {

    await ensureCommissionTable();

    const body = req.body || {};

    const employeeId =
      String(body.employeeId || "").trim();

    const employeeName =
      String(body.employeeName || "").trim();

    const username =
      String(body.username || "").trim();

    const referral =
      String(body.referral || "").trim();

    const transactionId =
      String(
        body.transaction_id ||
        body.transactionId ||
        ""
      ).trim();

    const reference =
      String(body.reference || "").trim();

    const paymentAmount =
      Number(
        body.amount ||
        body.paymentAmount ||
        0
      );

    if (!employeeId) {
      return res.status(400).json({
        success: false,
        error: "Employee ID is required"
      });
    }

    if (!referral) {
      return res.status(400).json({
        success: false,
        error: "Referral is required"
      });
    }

    if (!transactionId) {
      return res.status(400).json({
        success: false,
        error: "Transaction ID is required"
      });
    }

    if (
      !Number.isFinite(paymentAmount) ||
      paymentAmount <= 0
    ) {
      return res.status(400).json({
        success: false,
        error: "Invalid payment amount"
      });
    }

    /*
    ========================================
    VERIFY PAYMENT
    ========================================
    */

    const paymentResult = await pool.query(
      `
      SELECT
        reference,
        amount,
        status,
        transaction_request_id,
        transaction_id,
        transaction_code
      FROM payments
      WHERE
        transaction_id = $1
        OR transaction_code = $1
        OR transaction_request_id = $1
        OR reference = $2
      ORDER BY updated_at DESC
      LIMIT 1
      `,
      [
        transactionId,
        reference
      ]
    );

    if (paymentResult.rows.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Payment not found"
      });
    }

    const payment =
      paymentResult.rows[0];

    const paymentStatus =
      String(
        payment.status || ""
      ).toLowerCase();

    if (
      paymentStatus !== "completed" &&
      paymentStatus !== "paid" &&
      paymentStatus !== "success"
    ) {
      return res.status(400).json({
        success: false,
        error: "Payment is not completed"
      });
    }

    /*
    ========================================
    USE CONFIRMED PAYMENT AMOUNT
    ========================================
    */

    const confirmedAmount =
      Number(
        payment.amount
      );

    if (
      !Number.isFinite(
        confirmedAmount
      ) ||
      confirmedAmount <= 0
    ) {
      return res.status(400).json({
        success: false,
        error: "Invalid confirmed payment amount"
      });
    }

    /*
    ========================================
    40% COMMISSION
    ========================================
    */

    const commission =
      Number(
        (
          confirmedAmount *
          COMMISSION_RATE
        ).toFixed(2)
      );

    /*
    ========================================
    PREVENT DUPLICATE COMMISSION
    ========================================
    */

    const insertResult =
      await pool.query(
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
          $1,$2,$3,$4,$5,$6,$7,$8
        )
        ON CONFLICT (transaction_id)
        DO NOTHING
        RETURNING *
        `,
        [
          transactionId,
          payment.reference || reference,
          employeeId,
          username,
          referral,
          confirmedAmount,
          COMMISSION_RATE,
          commission
        ]
      );

    /*
    ========================================
    ALREADY RECORDED
    ========================================
    */

    if (
      insertResult.rows.length === 0
    ) {

      const existing =
        await pool.query(
          `
          SELECT *
          FROM employee_commissions
          WHERE transaction_id = $1
          LIMIT 1
          `,
          [transactionId]
        );

      return res.status(200).json({
        success: true,
        alreadyRecorded: true,
        commission:
          existing.rows.length
            ? Number(
                existing.rows[0]
                  .commission_amount || 0
              )
            : commission,
        commissionRate:
          COMMISSION_RATE
      });
    }

    return res.status(200).json({
      success: true,
      alreadyRecorded: false,
      employeeId,
      employeeName,
      username,
      referral,
      paymentAmount: confirmedAmount,
      commissionRate:
        COMMISSION_RATE,
      commission
    });

  } catch (error) {

    console.error(
      "Employee commission error:",
      error
    );

    return res.status(500).json({
      success: false,
      error:
        "Unable to record employee commission"
    });
  }
};
