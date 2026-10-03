const crypto = require("crypto");
const { query, ensurePaymentTable } = require("./db");

function json(res, status, data) {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  return res.end(JSON.stringify(data));
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return json(res, 405, {
      success: false,
      message: "Method not allowed"
    });
  }

  try {
    const consumerSecret = String(
      process.env.UNIFIEDPAY_CONSUMER_SECRET || ""
    ).trim();

    if (!consumerSecret) {
      return json(res, 500, {
        success: false,
        message: "Callback secret is not configured."
      });
    }

    let rawBody = "";

    if (typeof req.body === "string") {
      rawBody = req.body;
    } else if (req.body) {
      rawBody = JSON.stringify(req.body);
    }

    const receivedSignature = String(
      req.headers["x-unifiedpay-signature"] || ""
    ).trim();

    if (!receivedSignature) {
      return json(res, 401, {
        success: false,
        message: "Missing callback signature."
      });
    }

    const expectedSignature =
      "sha256=" +
      crypto
        .createHmac("sha256", consumerSecret)
        .update(rawBody)
        .digest("hex");

    const receivedBuffer =
      Buffer.from(receivedSignature);

    const expectedBuffer =
      Buffer.from(expectedSignature);

    if (
      receivedBuffer.length !==
        expectedBuffer.length ||
      !crypto.timingSafeEqual(
        receivedBuffer,
        expectedBuffer
      )
    ) {
      return json(res, 401, {
        success: false,
        message: "Invalid callback signature."
      });
    }

    let data;

    try {
      data = JSON.parse(rawBody);
    } catch {
      return json(res, 400, {
        success: false,
        message: "Invalid callback JSON."
      });
    }

    const event = String(
      data.event ||
      req.headers["x-unifiedpay-event"] ||
      ""
    ).trim();

    const transactionId = String(
      data.transaction_request_id || ""
    ).trim();

    const transactionStatus = String(
      data.TransactionStatus || ""
    ).trim();

    const transactionCode = String(
      data.TransactionCode || ""
    ).trim();

    const reference = String(
      data.TransactionReference || ""
    ).trim();

    console.log(
      "UNIFIEDPAY_CALLBACK",
      JSON.stringify({
        event,
        transaction_request_id:
          transactionId,
        status:
          transactionStatus,
        code:
          transactionCode,
        reference
      })
    );

    if (!transactionId) {
      return json(res, 400, {
        success: false,
        message:
          "Missing transaction request ID."
      });
    }

    await ensurePaymentTable();

    /*
    ==========================================
    PAYMENT COMPLETED
    ==========================================
    */

    if (
      event === "transaction.completed" &&
      transactionStatus.toLowerCase() ===
        "completed" &&
      transactionCode === "0"
    ) {

      await query(
        `
        UPDATE payments
        SET
          status = 'completed',
          transaction_request_id = $1,
          transaction_id = $1,
          transaction_code = $2,
          updated_at = NOW()
        WHERE
          transaction_request_id = $1
          OR reference = $3
        `,
        [
          transactionId,
          transactionCode,
          reference
        ]
      );

      console.log(
        "UNIFIEDPAY_PAYMENT_COMPLETED",
        JSON.stringify({
          transaction_request_id:
            transactionId,
          reference,
          amount:
            data.TransactionAmount ||
            null,
          receipt:
            data.TransactionReceipt ||
            null
        })
      );

      return json(res, 200, {
        success: true,
        received: true,
        paid: true,
        status: "Completed",
        transaction_request_id:
          transactionId
      });
    }

    /*
    ==========================================
    PAYMENT FAILED
    ==========================================
    */

    if (
      event === "transaction.failed"
    ) {

      await query(
        `
        UPDATE payments
        SET
          status = 'failed',
          transaction_request_id =
            COALESCE(
              transaction_request_id,
              $1
            ),
          transaction_id =
            COALESCE(
              transaction_id,
              $1
            ),
          transaction_code = $2,
          updated_at = NOW()
        WHERE
          transaction_request_id = $1
          OR reference = $3
        `,
        [
          transactionId,
          transactionCode,
          reference
        ]
      );

      return json(res, 200, {
        success: true,
        received: true,
        paid: false,
        status: "Failed",
        transaction_request_id:
          transactionId
      });
    }

    /*
    ==========================================
    PAYMENT CANCELLED
    ==========================================
    */

    if (
      event === "transaction.cancelled"
    ) {

      await query(
        `
        UPDATE payments
        SET
          status = 'cancelled',
          transaction_request_id =
            COALESCE(
              transaction_request_id,
              $1
            ),
          transaction_id =
            COALESCE(
              transaction_id,
              $1
            ),
          transaction_code = $2,
          updated_at = NOW()
        WHERE
          transaction_request_id = $1
          OR reference = $3
        `,
        [
          transactionId,
          transactionCode,
          reference
        ]
      );

      return json(res, 200, {
        success: true,
        received: true,
        paid: false,
        status: "Cancelled",
        transaction_request_id:
          transactionId
      });
    }

    /*
    ==========================================
    UNIFIEDPAY TEST CALLBACK
    ==========================================
    */

    if (event === "test") {

      console.log(
        "UNIFIEDPAY_TEST_CALLBACK_RECEIVED"
      );

      return json(res, 200, {
        success: true,
        received: true,
        test: true
      });
    }

    /*
    ==========================================
    OTHER EVENTS
    ==========================================
    */

    return json(res, 200, {
      success: true,
      received: true,
      paid: false,
      status:
        transactionStatus ||
        "Unknown",
      transaction_request_id:
        transactionId
    });

  } catch (error) {

    console.error(
      "UNIFIEDPAY_CALLBACK_ERROR",
      error
    );

    return json(res, 500, {
      success: false,
      message:
        "Callback processing failed."
    });
  }
};
