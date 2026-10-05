const crypto = require("crypto");
const { query, ensurePaymentTable } = require("./db");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  try {
    const API_KEY = process.env.PAYLOR_API_KEY;
    const CHANNEL_ID = process.env.PAYLOR_CHANNEL_ID;

    if (!API_KEY) {
      return res.status(500).json({
        success: false,
        message: "Paylor API key is not configured on the server"
      });
    }

    await ensurePaymentTable();

    const {
      phone,
      amount,
      reference
    } = req.body || {};

    if (!phone || !amount || !reference) {
      return res.status(400).json({
        success: false,
        message: "phone, amount and reference are required"
      });
    }

    /*
     * Normalize phone number
     */

    let cleanPhone = String(phone).replace(/\D/g, "");

    if (cleanPhone.startsWith("0")) {
      cleanPhone = "254" + cleanPhone.substring(1);
    }

    if (cleanPhone.startsWith("7") && cleanPhone.length === 9) {
      cleanPhone = "254" + cleanPhone;
    }

    if (!/^2547\d{8}$/.test(cleanPhone)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid Safaricom number"
      });
    }

    const paymentAmount = Number(amount);

    if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment amount"
      });
    }

    /*
     * ---------------------------------------------------------
     * Prevent duplicate reference
     * ---------------------------------------------------------
     */

    const existing = await query(
      `
      SELECT *
      FROM payments
      WHERE reference = $1
      LIMIT 1
      `,
      [reference]
    );

    if (existing.rows.length > 0) {
      const oldPayment = existing.rows[0];

      if (oldPayment.status === "completed") {
        return res.status(200).json({
          success: true,
          paid: true,
          status: "COMPLETED",
          reference: oldPayment.reference,
          transaction_id:
            oldPayment.transaction_id ||
            oldPayment.transaction_request_id ||
            null
        });
      }

      if (
        oldPayment.status === "pending" &&
        (
          oldPayment.transaction_id ||
          oldPayment.transaction_request_id
        )
      ) {
        return res.status(200).json({
          success: true,
          paid: false,
          status: "PENDING",
          reference: oldPayment.reference,
          transaction_id:
            oldPayment.transaction_id ||
            oldPayment.transaction_request_id
        });
      }
    }

    /*
     * ---------------------------------------------------------
     * Create pending payment
     * ---------------------------------------------------------
     */

    await query(
      `
      INSERT INTO payments (
        reference,
        amount,
        phone,
        status
      )
      VALUES ($1, $2, $3, 'pending')
      ON CONFLICT (reference)
      DO UPDATE SET
        amount = EXCLUDED.amount,
        phone = EXCLUDED.phone,
        updated_at = NOW()
      `,
      [
        reference,
        paymentAmount,
        cleanPhone
      ]
    );

    /*
     * ---------------------------------------------------------
     * Callback URL
     * ---------------------------------------------------------
     */

    const host =
      req.headers["x-forwarded-host"] ||
      req.headers.host ||
      process.env.VERCEL_URL;

    const protocol =
      req.headers["x-forwarded-proto"] ||
      "https";

    const callbackUrl =
      `${protocol}://${host}/api/payment-callback`;

    /*
     * ---------------------------------------------------------
     * Idempotency key
     * ---------------------------------------------------------
     */

    const idempotencyKey = crypto
      .createHash("sha256")
      .update(`${reference}:${cleanPhone}:${paymentAmount}`)
      .digest("hex");

    /*
     * ---------------------------------------------------------
     * Paylor STK Push
     * ---------------------------------------------------------
     */

    const payload = {
      phone: cleanPhone,
      amount: paymentAmount,
      reference: reference,
      callbackUrl: callbackUrl
    };

    if (CHANNEL_ID) {
      payload.channelId = CHANNEL_ID;
    }

    const response = await fetch(
      "https://api.paylorke.com/api/v1/merchants/payments/stk-push",
      {
        method: "POST",

        headers: {
          "Authorization": `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey
        },

        body: JSON.stringify(payload)
      }
    );

    const rawText = await response.text();

    let data;

    try {
      data = JSON.parse(rawText);
    } catch {
      data = {
        message: rawText
      };
    }

    /*
     * ---------------------------------------------------------
     * Paylor error
     * ---------------------------------------------------------
     */

    if (!response.ok) {
      console.error(
        "PAYLOR STK ERROR:",
        response.status,
        data
      );

      return res.status(response.status).json({
        success: false,
        message:
          data?.error?.message ||
          data?.message ||
          "Unable to send M-Pesa prompt",
        code:
          data?.error?.code ||
          null
      });
    }

    /*
     * ---------------------------------------------------------
     * Paylor success
     * ---------------------------------------------------------
     *
     * Expected:
     *
     * {
     *   transactionId: "...",
     *   status: "SENT"
     * }
     */

    const transactionId =
      data.transactionId ||
      data.id ||
      data.transaction?.id ||
      null;

    const status =
      String(
        data.status ||
        data.transaction?.status ||
        "SENT"
      ).toUpperCase();

    if (!transactionId) {
      console.error(
        "Paylor returned no transactionId:",
        data
      );

      return res.status(502).json({
        success: false,
        message: "Paylor did not return a transaction ID"
      });
    }

    /*
     * ---------------------------------------------------------
     * Save Paylor transaction ID
     * ---------------------------------------------------------
     */

    await query(
      `
      UPDATE payments
      SET
        transaction_id = $1,
        status = 'pending',
        updated_at = NOW()
      WHERE reference = $2
      `,
      [
        transactionId,
        reference
      ]
    );

    /*
     * ---------------------------------------------------------
     * Return to payment.html
     * ---------------------------------------------------------
     */

    return res.status(200).json({
      success: true,
      paid: false,
      status: status,
      reference: reference,
      transaction_id: transactionId,
      paymentId: transactionId,
      transaction_request_id: transactionId,
      message: "M-Pesa prompt sent successfully"
    });

  } catch (error) {
    console.error(
      "PAYLOR STK PUSH ERROR:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Unable to start M-Pesa payment"
    });
  }
};
