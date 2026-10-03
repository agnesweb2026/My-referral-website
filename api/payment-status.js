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

    // =========================
    // UNIFIEDPAY CREDENTIALS
    // =========================
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

    // =========================
    // UNIFIEDPAY STATUS URL
    // =========================
    const url =
      "https://unifiedpay.co.ke/auth/cred/" +
      encodeURIComponent(consumerKey) +
      "/" +
      encodeURIComponent(consumerSecret) +
      "/sendstatus";

    // =========================
    // CHECK PAYMENT
    // =========================
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
      "UNIFIEDPAY_PAYMENT_STATUS",
      JSON.stringify({
        httpStatus: response.status,
        transaction_request_id:
          transactionId,
        ResponseCode:
          data.ResponseCode || null,
        TransactionStatus:
          data.TransactionStatus || null
      })
    );

    // =========================
    // NORMALIZE STATUS
    // =========================
    const paymentStatus = String(
      data.TransactionStatus ||
      data.transaction_status ||
      data.status ||
      ""
    ).toLowerCase().trim();

    // =========================
    // COMPLETED
    // =========================
    const paid =
      paymentStatus === "completed" ||
      paymentStatus === "complete" ||
      paymentStatus === "success" ||
      paymentStatus === "successful" ||
      paymentStatus === "paid";

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
          data.TransactionAmount ||
          data.amount ||
          null,

        phone:
          data.Msisdn ||
          data.msisdn ||
          data.phone ||
          null,

        reference:
          data.TransactionReference ||
          data.reference ||
          null,

        mpesa_receipt:
          data.TransactionReceipt ||
          data.mpesa_receipt ||
          data.receipt ||
          null,

        message:
          data.ResultDesc ||
          data.message ||
          "Payment completed successfully."
      });
    }

    // =========================
    // FAILED / CANCELLED
    // =========================
    const failed =
      paymentStatus === "failed" ||
      paymentStatus === "failure" ||
      paymentStatus === "cancelled" ||
      paymentStatus === "canceled" ||
      paymentStatus === "rejected";

    if (failed) {
      return json(res, 200, {
        success: true,
        paid: false,

        status:
          data.TransactionStatus ||
          "Failed",

        transaction_id:
          transactionId,

        transaction_request_id:
          transactionId,

        message:
          data.ResultDesc ||
          data.message ||
          "Payment was not completed."
      });
    }

    // =========================
    // STILL PENDING
    // =========================
    return json(res, 200, {
      success: true,
      paid: false,

      status:
        data.TransactionStatus ||
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
