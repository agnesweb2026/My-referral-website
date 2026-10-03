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

    // ==========================================
    // VALIDATE TRANSACTION ID
    // ==========================================
    if (!transactionId) {
      return json(res, 400, {
        success: false,
        paid: false,
        message: "Missing transaction ID."
      });
    }

    if (transactionId.length > 100) {
      return json(res, 400, {
        success: false,
        paid: false,
        message: "Invalid transaction ID."
      });
    }

    // ==========================================
    // UNIFIEDPAY CREDENTIALS
    // ==========================================
    const consumerKey = String(
      process.env.UNIFIEDPAY_CONSUMER_KEY || ""
    ).trim();

    const consumerSecret = String(
      process.env.UNIFIEDPAY_CONSUMER_SECRET || ""
    ).trim();

    if (
      !consumerKey ||
      !consumerSecret
    ) {
      return json(res, 500, {
        success: false,
        paid: false,
        message:
          "UnifiedPay credentials are not configured on the server."
      });
    }

    // ==========================================
    // UNIFIEDPAY STATUS ENDPOINT
    // ==========================================
    const url =
      "https://unifiedpay.co.ke/auth/cred/" +
      encodeURIComponent(consumerKey) +
      "/" +
      encodeURIComponent(consumerSecret) +
      "/sendstatus";

    // ==========================================
    // CHECK TRANSACTION
    // ==========================================
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
      data = JSON.parse(
        responseText
      );
    } catch {
      data = {
        success: false,
        message:
          responseText ||
          "UnifiedPay returned an invalid response."
      };
    }

    // ==========================================
    // NORMALIZE STATUS
    // ==========================================
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

    // ==========================================
    // SUCCESS CONDITIONS
    // ==========================================
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

    // ==========================================
    // PAID
    // ==========================================
    if (paid) {
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

    // ==========================================
    // FAILED
    // ==========================================
    if (
      status === "failed" ||
      status === "failure" ||
      status === "rejected"
    ) {
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

    // ==========================================
    // CANCELLED
    // ==========================================
    if (
      status === "cancelled" ||
      status === "canceled"
    ) {
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

    // ==========================================
    // PENDING
    // ==========================================
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
