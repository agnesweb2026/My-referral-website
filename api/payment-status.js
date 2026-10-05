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
      paid: false,
      message: "Method not allowed"
    });
  }

  try {
    const {
      transaction_id,
      transaction_request_id
    } = req.body || {};

    const transactionId = String(
      transaction_id ||
      transaction_request_id ||
      ""
    ).trim();

    if (!transactionId) {
      return json(res, 400, {
        success: false,
        paid: false,
        message: "Missing transaction ID."
      });
    }

    if (transactionId.length > 200) {
      return json(res, 400, {
        success: false,
        paid: false,
        message: "Invalid transaction ID."
      });
    }

    const apiKey =
      String(process.env.PAYLOR_API_KEY || "").trim();

    if (!apiKey) {
      return json(res, 500, {
        success: false,
        paid: false,
        message:
          "Paylor API key is not configured on the server."
      });
    }

    await ensurePaymentTable();

    // ============================================
    // 1. CHECK OUR DATABASE FIRST
    // ============================================

    const saved = await query(
      `
      SELECT
        reference,
        amount,
        phone,
        status,
        transaction_request_id,
        transaction_id,
        transaction_code
      FROM payments
      WHERE
        transaction_request_id = $1
        OR transaction_id = $1
      ORDER BY updated_at DESC
      LIMIT 1
      `,
      [transactionId]
    );

    if (saved.rows.length > 0) {
      const payment = saved.rows[0];

      const savedStatus = String(
        payment.status || ""
      )
        .trim()
        .toLowerCase();

      if (
        savedStatus === "completed" ||
        savedStatus === "complete" ||
        savedStatus === "paid" ||
        savedStatus === "successful" ||
        savedStatus === "success"
      ) {
        return json(res, 200, {
          success: true,
          paid: true,
          status: "Completed",

          transaction_id:
            payment.transaction_id || transactionId,

          transaction_request_id:
            payment.transaction_request_id || transactionId,

          amount:
            payment.amount ?? null,

          phone:
            payment.phone ?? null,

          reference:
            payment.reference ?? null,

          message:
            "Payment completed successfully."
        });
      }

      if (
        savedStatus === "failed" ||
        savedStatus === "failure" ||
        savedStatus === "rejected"
      ) {
        return json(res, 200, {
          success: true,
          paid: false,
          status: "Failed",

          transaction_id:
            payment.transaction_id || transactionId,

          transaction_request_id:
            payment.transaction_request_id || transactionId,

          message: "Payment failed."
        });
      }

      if (
        savedStatus === "cancelled" ||
        savedStatus === "canceled"
      ) {
        return json(res, 200, {
          success: true,
          paid: false,
          status: "Cancelled",

          transaction_id:
            payment.transaction_id || transactionId,

          transaction_request_id:
            payment.transaction_request_id || transactionId,

          message: "Payment was cancelled."
        });
      }
    }

    // ============================================
    // 2. ASK PAYLOR FOR CURRENT TRANSACTION STATUS
    // ============================================

    const response = await fetch(
      `https://api.paylorke.com/api/v1/merchants/payments/transactions/${encodeURIComponent(
        transactionId
      )}`,
      {
        method: "GET",

        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json"
        }
      }
    );

    const responseText = await response.text();

    let data = {};

    try {
      data = responseText
        ? JSON.parse(responseText)
        : {};
    } catch {
      data = {};
    }

    console.log(
      "PAYLOR_STATUS_RESULT",
      JSON.stringify({
        transaction_id: transactionId,
        httpStatus: response.status,
        status: data.status || null,
        reference: data.reference || null,
        mpesaReceipt:
          data.mpesaReceipt || null
      })
    );

    // ============================================
    // 3. NORMALIZE STATUS
    // ============================================

    const status = String(
      data.status || ""
    )
      .trim()
      .toUpperCase();

    const completed =
      status === "COMPLETED" ||
      status === "CONFIRMED" ||
      status === "SUCCESS" ||
      status === "PAID";

    const failed =
      status === "FAILED" ||
      status === "FAILURE" ||
      status === "REJECTED";

    const cancelled =
      status === "CANCELLED" ||
      status === "CANCELED";

    // ============================================
    // 4. PAYMENT COMPLETED
    // ============================================

    if (response.ok && completed) {
      await query(
        `
        UPDATE payments
        SET
          status = 'completed',

          transaction_id =
            COALESCE(transaction_id, $1),

          transaction_request_id =
            COALESCE(transaction_request_id, $1),

          transaction_code =
            COALESCE(transaction_code, $2),

          updated_at = NOW()

        WHERE
          transaction_request_id = $1
          OR transaction_id = $1
        `,
        [
          transactionId,
          data.mpesaReceipt ||
            data.providerRef ||
            null
        ]
      );

      return json(res, 200, {
        success: true,
        paid: true,
        status: "Completed",

        transaction_id:
          data.id || transactionId,

        transaction_request_id:
          data.id || transactionId,

        amount:
          data.amount ?? null,

        reference:
          data.reference ?? null,

        mpesa_receipt:
          data.mpesaReceipt ?? null,

        message:
          "Payment completed successfully."
      });
    }

    // ============================================
    // 5. PAYMENT FAILED
    // ============================================

    if (failed) {
      await query(
        `
        UPDATE payments
        SET
          status = 'failed',
          updated_at = NOW()
        WHERE
          transaction_request_id = $1
          OR transaction_id = $1
        `,
        [transactionId]
      );

      return json(res, 200, {
        success: true,
        paid: false,
        status: "Failed",

        transaction_id: transactionId,

        transaction_request_id:
          transactionId,

        message:
          data.message ||
          "Payment failed."
      });
    }

    // ============================================
    // 6. PAYMENT CANCELLED
    // ============================================

    if (cancelled) {
      await query(
        `
        UPDATE payments
        SET
          status = 'cancelled',
          updated_at = NOW()
        WHERE
          transaction_request_id = $1
          OR transaction_id = $1
        `,
        [transactionId]
      );

      return json(res, 200, {
        success: true,
        paid: false,
        status: "Cancelled",

        transaction_id: transactionId,

        transaction_request_id:
          transactionId,

        message:
          data.message ||
          "Payment was cancelled."
      });
    }

    // ============================================
    // 7. STILL PENDING
    // ============================================

    return json(res, 200, {
      success: true,
      paid: false,

      status:
        data.status || "PENDING",

      transaction_id:
        data.id || transactionId,

      transaction_request_id:
        data.id || transactionId,

      reference:
        data.reference ?? null,

      message:
        data.message ||
        "Payment is still pending."
    });

  } catch (error) {
    console.error(
      "PAYLOR_STATUS_ERROR",
      error
    );

    return json(res, 500, {
      success: false,
      paid: false,
      message:
        "Unable to check the M-PESA payment status."
    });
  }
};
