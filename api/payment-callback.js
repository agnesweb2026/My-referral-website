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
    const secret = process.env.PAYLOR_WEBHOOK_SECRET;

    if (!secret) {
      console.error("PAYLOR_WEBHOOK_SECRET is missing");

      return res.status(500).json({
        success: false,
        message: "Paylor webhook secret is not configured"
      });
    }

    await ensurePaymentTable();

    /*
     * Vercel may already give us req.body.
     * Paylor signs the EXACT raw JSON bytes.
     *
     * If req.rawBody exists, use it.
     * Otherwise reconstruct the body consistently.
     */

    let rawBody;

    if (req.rawBody) {
      rawBody = Buffer.isBuffer(req.rawBody)
        ? req.rawBody
        : Buffer.from(req.rawBody);
    } else if (typeof req.body === "string") {
      rawBody = Buffer.from(req.body);
    } else {
      rawBody = Buffer.from(JSON.stringify(req.body || {}));
    }

    const signature =
      req.headers["x-webhook-signature"] ||
      req.headers["X-Webhook-Signature"];

    if (!signature) {
      console.error("Missing Paylor webhook signature");

      return res.status(401).json({
        success: false,
        message: "Missing webhook signature"
      });
    }

    /*
     * Paylor:
     * HMAC SHA-256 of the exact raw request body
     */

    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    /*
     * Timing-safe comparison
     */

    const providedBuffer = Buffer.from(String(signature));
    const expectedBuffer = Buffer.from(expectedSignature);

    if (
      providedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(
        providedBuffer,
        expectedBuffer
      )
    ) {
      console.error("Invalid Paylor webhook signature");

      return res.status(401).json({
        success: false,
        message: "Invalid webhook signature"
      });
    }

    const body =
      typeof req.body === "object"
        ? req.body
        : JSON.parse(rawBody.toString("utf8"));

    const event = body.event;
    const transaction = body.transaction || {};

    const reference =
      transaction.reference ||
      body.reference ||
      transaction.merchantReference ||
      body.merchantReference;

    const transactionId =
      transaction.id ||
      body.transactionId ||
      body.id ||
      null;

    const providerRef =
      transaction.providerRef ||
      body.providerRef ||
      null;

    const mpesaReceipt =
      transaction.mpesaReceipt ||
      transaction.metadata?.mpesaReceipt ||
      body.mpesaReceipt ||
      null;

    const status = String(
      transaction.status ||
      body.status ||
      ""
    ).toUpperCase();

    if (!reference) {
      console.error("Paylor webhook has no payment reference");

      return res.status(200).json({
        received: true,
        processed: false
      });
    }

    /*
     * PAYMENT SUCCESS
     */

    if (
      event === "payment.success" ||
      status === "COMPLETED" ||
      status === "CONFIRMED"
    ) {
      await query(
        `
        UPDATE payments
        SET
          status = 'completed',
          transaction_id = COALESCE($1, transaction_id),
          transaction_code = COALESCE($2, transaction_code),
          updated_at = NOW()
        WHERE reference = $3
        `,
        [
          transactionId,
          mpesaReceipt || providerRef,
          reference
        ]
      );

      console.log(
        "PAYLOR PAYMENT COMPLETED:",
        reference,
        transactionId,
        mpesaReceipt
      );

      return res.status(200).json({
        received: true,
        processed: true,
        paid: true
      });
    }

    /*
     * PAYMENT FAILED
     */

    if (
      event === "payment.failed" ||
      status === "FAILED" ||
      status === "CANCELLED" ||
      status === "CANCELED" ||
      status === "REJECTED"
    ) {
      await query(
        `
        UPDATE payments
        SET
          status = 'failed',
          transaction_id = COALESCE($1, transaction_id),
          updated_at = NOW()
        WHERE reference = $2
        `,
        [
          transactionId,
          reference
        ]
      );

      console.log(
        "PAYLOR PAYMENT FAILED:",
        reference
      );

      return res.status(200).json({
        received: true,
        processed: true,
        paid: false
      });
    }

    /*
     * OTHER EVENTS
     */

    console.log(
      "PAYLOR WEBHOOK RECEIVED:",
      event,
      reference,
      status
    );

    return res.status(200).json({
      received: true,
      processed: false
    });

  } catch (error) {
    console.error(
      "PAYLOR WEBHOOK ERROR:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Webhook processing failed"
    });
  }
};
