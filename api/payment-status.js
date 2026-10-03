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
      transaction_request_id,
      transaction_id
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

    if (transactionId.length > 150) {
      return json(res, 400, {
        success: false,
        paid: false,
        message: "Invalid transaction ID."
      });
    }

    await ensurePaymentTable();

    /*
    ==========================================
    STEP 1
    CHECK OUR DATABASE FIRST
    ==========================================
    */

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
      ).trim().toLowerCase();

      /*
      ========================================
      PAYMENT ALREADY CONFIRMED
      ========================================
      */

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
            payment.transaction_id ||
            transactionId,

          transaction_request_id:
            payment.transaction_request_id ||
            transactionId,

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

      /*
      ========================================
      PAYMENT FAILED
      ========================================
      */

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
            payment.transaction_id ||
            transactionId,

          transaction_request_id:
            payment.transaction_request_id ||
            transactionId,

          message:
            "Payment failed."
        });
      }

      /*
      ========================================
      PAYMENT CANCELLED
      ========================================
      */

      if (
        savedStatus === "cancelled" ||
        savedStatus === "canceled"
      ) {
        return json(res, 200, {
          success: true,
          paid: false,
          status: "Cancelled",

          transaction_id:
            payment.transaction_id ||
            transactionId,

          transaction_request_id:
            payment.transaction_request_id ||
            transactionId,

          message:
            "Payment was cancelled."
        });
      }
    }

    /*
    ==========================================
    STEP 2
    DATABASE IS STILL PENDING
    CHECK UNIFIEDPAY
    ==========================================
    */

    const consumerKey = String(
      process.env.UNIFIEDPAY_CONSUMER_KEY || ""
    ).trim();

    const consumerSecret = String(
      process.env.UNIFIEDPAY_CONSUMER_SECRET || ""
    ).trim();

    if (!consumerKey || !consumerSecret) {
      return json(res, 500, {
        success: false,
        paid: false,
        message:
          "UnifiedPay credentials are not configured on the server."
      });
    }

    const url =
      "https://unifiedpay.co.ke/auth/cred/" +
      encodeURIComponent(consumerKey) +
      "/" +
      encodeURIComponent(consumerSecret) +
      "/sendstatus";

    const response = await fetch(url, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },

      body: JSON.stringify({
        transaction_request_id:
          transactionId
      })
    });

    const responseText =
      await response.text();

    let data;

    try {
      data = JSON.parse(responseText);
    } catch {
      data = {
        success: false,
        message:
          responseText ||
          "UnifiedPay returned an invalid response."
      };
    }

    console.log(
      "UNIFIEDPAY_STATUS_RESULT",
      JSON.stringify({
        transaction_request_id:
          transactionId,
        httpStatus:
          response.status,
        status:
          data.TransactionStatus ||
          data.transaction_status ||
          data.status ||
          null,
        responseCode:
          data.ResponseCode ?? null,
        resultCode:
          data.ResultCode ?? null
      })
    );

    const status = String(
      data.TransactionStatus ||
      data.transaction_status ||
      data.status ||
      ""
    ).trim().toLowerCase();

    const responseCode = String(
      data.ResponseCode ?? ""
    ).trim();

    const resultCode = String(
      data.ResultCode ?? ""
    ).trim();

    const completed =
      status === "completed" ||
      status === "complete" ||
      status === "successful" ||
      status === "success" ||
      status === "paid";

    const successfulCode =
      responseCode === "0" ||
      resultCode === "0";

    const paid =
      completed &&
      (
        successfulCode ||
        data.success === true
      );

    /*
    ==========================================
    UNIFIEDPAY CONFIRMED PAYMENT
    SAVE IT TO DATABASE
    ==========================================
    */

    if (paid) {

      await query(
        `
        UPDATE payments
        SET
          status = 'completed',
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
          transaction_code =
            COALESCE(
              transaction_code,
              $2
            ),
          updated_at = NOW()
        WHERE
          transaction_request_id = $1
          OR transaction_id = $1
        `,
        [
          transactionId,
          data.TransactionCode ||
            data.transaction_code ||
            "0"
        ]
      );

      return json(res, 200, {
        success: true,
        paid: true,
        status: "Completed",

        transaction_id:
          transactionId,

        transaction_request_id:
          transactionId,

        amount:
          data.TransactionAmount ??
          data.amount ??
          null,

        phone:
          data.Msisdn ??
          data.msisdn ??
          data.phone ??
          null,

        reference:
          data.TransactionReference ??
          data.reference ??
          null,

        mpesa_receipt:
          data.TransactionReceipt ??
          data.mpesa_receipt ??
          data.receipt ??
          null,

        message:
          data.ResultDesc ||
          data.message ||
          "Payment completed successfully."
      });
    }

    /*
    ==========================================
    FAILED
    ==========================================
    */

    if (
      status === "failed" ||
      status === "failure" ||
      status === "rejected"
    ) {

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

        transaction_id:
          transactionId,

        transaction_request_id:
          transactionId,

        message:
          data.ResultDesc ||
          data.message ||
          "Payment failed."
      });
    }

    /*
    ==========================================
    CANCELLED
    ==========================================
    */

    if (
      status === "cancelled" ||
      status === "canceled"
    ) {

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

        transaction_id:
          transactionId,

        transaction_request_id:
          transactionId,

        message:
          data.ResultDesc ||
          data.message ||
          "Payment was cancelled."
      });
    }

    /*
    ==========================================
    STILL PENDING
    ==========================================
    */

    return json(res, 200, {
      success: true,
      paid: false,

      status:
        data.TransactionStatus ||
        data.transaction_status ||
        data.status ||
        "Pending",

      transaction_id:
        transactionId,

      transaction_request_id:
        transactionId,

      message:
        data.ResultDesc ||
        data.message ||
        "Payment is still pending."
    });

  } catch (error) {

    console.error(
      "UNIFIEDPAY_STATUS_ERROR",
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
