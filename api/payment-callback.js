const crypto = require("crypto");

function json(res, status, data) {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  return res.end(JSON.stringify(data));
}

module.exports = async (req, res) => {
  // UnifiedPay sends POST requests
  if (req.method !== "POST") {
    return json(res, 405, {
      success: false,
      message: "Method not allowed"
    });
  }

  try {
    // ==========================================
    // GET UNIFIEDPAY SECRET
    // ==========================================
    const consumerSecret = String(
      process.env.UNIFIEDPAY_CONSUMER_SECRET || ""
    ).trim();

    if (!consumerSecret) {
      console.error(
        "UNIFIEDPAY_CALLBACK: Missing consumer secret"
      );

      return json(res, 500, {
        success: false,
        message: "Callback secret is not configured."
      });
    }

    // ==========================================
    // GET RAW REQUEST BODY
    // ==========================================
    let rawBody = "";

    if (typeof req.body === "string") {
      rawBody = req.body;
    } else if (req.body) {
      rawBody = JSON.stringify(req.body);
    } else {
      rawBody = "";
    }

    // ==========================================
    // GET SIGNATURE
    // ==========================================
    const receivedSignature = String(
      req.headers["x-unifiedpay-signature"] || ""
    ).trim();

    if (!receivedSignature) {
      console.error(
        "UNIFIEDPAY_CALLBACK: Missing signature"
      );

      return json(res, 401, {
        success: false,
        message: "Missing callback signature."
      });
    }

    // ==========================================
    // CREATE EXPECTED HMAC SIGNATURE
    // ==========================================
    const expectedSignature =
      "sha256=" +
      crypto
        .createHmac(
          "sha256",
          consumerSecret
        )
        .update(rawBody)
        .digest("hex");

    // ==========================================
    // TIMING-SAFE SIGNATURE CHECK
    // ==========================================
    const receivedBuffer =
      Buffer.from(receivedSignature);

    const expectedBuffer =
      Buffer.from(expectedSignature);

    if (
      receivedBuffer.length !==
      expectedBuffer.length
    ) {
      console.error(
        "UNIFIEDPAY_CALLBACK: Invalid signature"
      );

      return json(res, 401, {
        success: false,
        message: "Invalid callback signature."
      });
    }

    const signatureValid =
      crypto.timingSafeEqual(
        receivedBuffer,
        expectedBuffer
      );

    if (!signatureValid) {
      console.error(
        "UNIFIEDPAY_CALLBACK: Invalid signature"
      );

      return json(res, 401, {
        success: false,
        message: "Invalid callback signature."
      });
    }

    // ==========================================
    // PARSE CALLBACK
    // ==========================================
    let data;

    try {
      data = JSON.parse(rawBody);
    } catch {
      return json(res, 400, {
        success: false,
        message: "Invalid callback JSON."
      });
    }

    // ==========================================
    // READ EVENT
    // ==========================================
    const event = String(
      data.event ||
      req.headers["x-unifiedpay-event"] ||
      ""
    ).trim();

    const transactionId = String(
      data.transaction_request_id ||
      ""
    ).trim();

    const transactionStatus = String(
      data.TransactionStatus ||
      ""
    ).trim();

    const transactionCode = String(
      data.TransactionCode ||
      ""
    ).trim();

    const reference = String(
      data.TransactionReference ||
      ""
    ).trim();

    // ==========================================
    // LOG SAFE INFORMATION
    // ==========================================
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

    // ==========================================
    // CHECK TRANSACTION ID
    // ==========================================
    if (!transactionId) {
      return json(res, 400, {
        success: false,
        message:
          "Missing transaction request ID."
      });
    }

    // ==========================================
    // COMPLETED PAYMENT
    // ==========================================
    if (
      event === "transaction.completed" &&
      transactionStatus === "Completed" &&
      transactionCode === "0"
    ) {
      console.log(
        "UNIFIEDPAY_PAYMENT_COMPLETED",
        JSON.stringify({
          transaction_request_id:
            transactionId,
          reference,
          amount:
            data.TransactionAmount || null,
          receipt:
            data.TransactionReceipt || null
        })
      );

      /*
       * IMPORTANT:
       *
       * Later we can connect this section
       * to your order/payment database.
       *
       * Do NOT give access based only on
       * the callback arriving.
       *
       * We will verify:
       * - transaction ID
       * - reference
       * - amount
       * - payment status
       *
       * before marking an order as PAID.
       */

      return json(res, 200, {
        success: true,
        received: true,
        paid: true,
        transaction_request_id:
          transactionId
      });
    }

    // ==========================================
    // FAILED PAYMENT
    // ==========================================
    if (
      event === "transaction.failed"
    ) {
      console.log(
        "UNIFIEDPAY_PAYMENT_FAILED",
        JSON.stringify({
          transaction_request_id:
            transactionId,
          reference,
          code:
            transactionCode
        })
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

    // ==========================================
    // CANCELLED PAYMENT
    // ==========================================
    if (
      event === "transaction.cancelled"
    ) {
      console.log(
        "UNIFIEDPAY_PAYMENT_CANCELLED",
        JSON.stringify({
          transaction_request_id:
            transactionId,
          reference
        })
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

    // ==========================================
    // TEST CALLBACK
    // ==========================================
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

    // ==========================================
    // UNKNOWN / OTHER EVENT
    // ==========================================
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
