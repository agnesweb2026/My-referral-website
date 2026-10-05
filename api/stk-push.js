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
    /*
    ========================================
    PAYLOR CREDENTIALS
    ========================================
    */

    const API_KEY = process.env.PAYLOR_API_KEY;
    const CHANNEL_ID = process.env.PAYLOR_CHANNEL_ID;

    if (!API_KEY) {
      return res.status(500).json({
        success: false,
        message: "Paylor API key is not configured on the server"
      });
    }

    if (!CHANNEL_ID) {
      return res.status(500).json({
        success: false,
        message: "Paylor channel ID is not configured on the server"
      });
    }

    /*
    ========================================
    DATABASE
    ========================================
    */

    await ensurePaymentTable();

    /*
    ========================================
    REQUEST DATA
    ========================================
    */

    const body = req.body || {};

    const phone = body.phone;
    const amount = body.amount;
    const reference = body.reference;

    if (!phone || !amount || !reference) {
      return res.status(400).json({
        success: false,
        message: "phone, amount and reference are required"
      });
    }

    /*
    ========================================
    NORMALIZE PHONE
    ========================================
    */

    let cleanPhone = String(phone)
      .replace(/\D/g, "")
      .trim();

    if (cleanPhone.startsWith("0")) {
      cleanPhone =
        "254" +
        cleanPhone.substring(1);
    }

    if (
      cleanPhone.startsWith("7") &&
      cleanPhone.length === 9
    ) {
      cleanPhone =
        "254" +
        cleanPhone;
    }

    if (!/^2547\d{8}$/.test(cleanPhone)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid Safaricom M-PESA number"
      });
    }

    /*
    ========================================
    AMOUNT
    ========================================
    */

    const paymentAmount =
      Number(amount);

    if (
      !Number.isFinite(paymentAmount) ||
      paymentAmount <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment amount"
      });
    }

    /*
    ========================================
    REFERENCE
    ========================================
    */

    const cleanReference =
      String(reference)
        .replace(/[^A-Za-z0-9_-]/g, "")
        .substring(0, 100);

    if (!cleanReference) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment reference"
      });
    }

    /*
    ========================================
    CHECK EXISTING PAYMENT
    ========================================
    */

    const existing =
      await query(
        `
        SELECT *
        FROM payments
        WHERE reference = $1
        LIMIT 1
        `,
        [cleanReference]
      );

    if (existing.rows.length > 0) {

      const oldPayment =
        existing.rows[0];

      /*
      Already completed
      */

      if (
        oldPayment.status ===
        "completed"
      ) {
        return res.status(200).json({
          success: true,
          paid: true,
          status: "COMPLETED",
          reference:
            oldPayment.reference,
          transaction_id:
            oldPayment.transaction_id ||
            oldPayment.transaction_request_id ||
            null,
          paymentId:
            oldPayment.transaction_id ||
            oldPayment.transaction_request_id ||
            null
        });
      }

      /*
      Existing pending transaction
      */

      if (
        oldPayment.status ===
        "pending" &&
        (
          oldPayment.transaction_id ||
          oldPayment.transaction_request_id
        )
      ) {
        return res.status(200).json({
          success: true,
          paid: false,
          status: "PENDING",
          reference:
            oldPayment.reference,
          transaction_id:
            oldPayment.transaction_id ||
            oldPayment.transaction_request_id,
          paymentId:
            oldPayment.transaction_id ||
            oldPayment.transaction_request_id
        });
      }
    }

    /*
    ========================================
    CREATE / RESET PENDING PAYMENT
    ========================================
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
        status = 'pending',
        updated_at = NOW()
      `,
      [
        cleanReference,
        paymentAmount,
        cleanPhone
      ]
    );

    /*
    ========================================
    CALLBACK URL
    ========================================
    */

    const forwardedHost =
      req.headers["x-forwarded-host"];

    const normalHost =
      req.headers.host;

    const vercelHost =
      process.env.VERCEL_URL;

    const host =
      forwardedHost ||
      normalHost ||
      vercelHost;

    if (!host) {
      return res.status(500).json({
        success: false,
        message: "Unable to determine website host"
      });
    }

    const forwardedProto =
      req.headers["x-forwarded-proto"];

    const protocol =
      forwardedProto ||
      "https";

    const callbackUrl =
      `${protocol}://${host}/api/payment-callback`;

    /*
    ========================================
    IDEMPOTENCY KEY
    ========================================
    */

    const idempotencyKey =
      crypto
        .createHash("sha256")
        .update(
          `${cleanReference}:${cleanPhone}:${paymentAmount}`
        )
        .digest("hex");

    /*
    ========================================
    PAYLOR PAYLOAD
    ========================================
    */

    const payload = {
      phone: cleanPhone,
      amount: paymentAmount,
      reference: cleanReference,
      channelId: CHANNEL_ID,
      description: "M-Pesa payment",
      callbackUrl: callbackUrl
    };

    console.log(
      "PAYLOR STK REQUEST:",
      {
        phone:
          cleanPhone.substring(0, 6) +
          "****",
        amount:
          paymentAmount,
        reference:
          cleanReference,
        channelId:
          CHANNEL_ID
      }
    );

    /*
    ========================================
    SEND STK PUSH TO PAYLOR
    ========================================
    */

    const response =
      await fetch(
        "https://api.paylorke.com/api/v1/merchants/payments/stk-push",
        {
          method: "POST",

          headers: {
            "Authorization":
              `Bearer ${API_KEY}`,

            "Content-Type":
              "application/json",

            "Accept":
              "application/json",

            "Idempotency-Key":
              idempotencyKey
          },

          body:
            JSON.stringify(payload)
        }
      );

    /*
    ========================================
    READ PAYLOR RESPONSE
    ========================================
    */

    const rawText =
      await response.text();

    let data;

    try {

      data =
        JSON.parse(rawText);

    } catch {

      data = {
        message: rawText
      };

    }

    console.log(
      "PAYLOR STK RESPONSE:",
      response.status,
      data
    );

    /*
    ========================================
    PAYLOR ERROR
    ========================================
    */

    if (!response.ok) {

      console.error(
        "PAYLOR STK ERROR:",
        response.status,
        data
      );

      /*
      Mark payment failed
      */

      await query(
        `
        UPDATE payments
        SET
          status = 'failed',
          updated_at = NOW()
        WHERE reference = $1
        `,
        [cleanReference]
      );

      const errorMessage =
        data?.error?.message ||
        data?.message ||
        data?.error ||
        "Unable to send M-PESA prompt";

      return res.status(
        response.status
      ).json({
        success: false,
        paid: false,
        message:
          String(errorMessage),
        reference:
          cleanReference
      });
    }

    /*
    ========================================
    GET TRANSACTION ID
    ========================================
    */

    const transactionId =
      data.transactionId ||
      data.transaction_id ||
      data.paymentId ||
      data.id ||
      data.transaction?.id ||
      data.data?.transactionId ||
      data.data?.id ||
      null;

    /*
    ========================================
    GET STATUS
    ========================================
    */

    const paylorStatus =
      String(
        data.status ||
        data.transaction?.status ||
        data.data?.status ||
        "SENT"
      ).toUpperCase();

    /*
    ========================================
    NO TRANSACTION ID
    ========================================
    */

    if (!transactionId) {

      console.error(
        "PAYLOR DID NOT RETURN TRANSACTION ID:",
        data
      );

      await query(
        `
        UPDATE payments
        SET
          status = 'failed',
          updated_at = NOW()
        WHERE reference = $1
        `,
        [cleanReference]
      );

      return res.status(502).json({
        success: false,
        paid: false,
        message:
          data?.message ||
          "Paylor did not return a transaction ID",
        reference:
          cleanReference
      });
    }

    /*
    ========================================
    SAVE TRANSACTION ID
    ========================================
    */

    await query(
      `
      UPDATE payments
      SET
        transaction_id = $1,
        transaction_request_id = $1,
        status = 'pending',
        updated_at = NOW()
      WHERE reference = $2
      `,
      [
        String(transactionId),
        cleanReference
      ]
    );

    /*
    ========================================
    SUCCESS RESPONSE
    ========================================
    */

    return res.status(200).json({
      success: true,
      paid: false,

      status:
        paylorStatus,

      reference:
        cleanReference,

      transaction_id:
        String(transactionId),

      transaction_request_id:
        String(transactionId),

      paymentId:
        String(transactionId),

      message:
        "M-PESA prompt sent successfully"
    });

  } catch (error) {

    console.error(
      "PAYLOR STK PUSH SERVER ERROR:",
      error
    );

    return res.status(500).json({
      success: false,
      paid: false,
      message:
        error?.message ||
        "Unable to start M-PESA payment"
    });
  }
};
