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
    const { transaction_request_id } = req.body || {};

    if (!transaction_request_id) {
      return json(res, 400, {
        success: false,
        message: "Missing transaction request ID."
      });
    }

    const consumerKey = String(
      process.env.UNIFIEDPAY_CONSUMER_KEY || ""
    ).trim();

    const consumerSecret = String(
      process.env.UNIFIEDPAY_CONSUMER_SECRET || ""
    ).trim();

    if (!consumerKey || !consumerSecret) {
      return json(res, 500, {
        success: false,
        message:
          "UnifiedPay credentials are not configured."
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
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        transaction_request_id
      })
    });

    const responseText = await response.text();

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
        httpStatus: response.status,
        transaction_request_id,
        status: data.TransactionStatus || null
      })
    );

    if (
      response.ok &&
      data.TransactionStatus === "Completed"
    ) {
      return json(res, 200, {
        success: true,
        paid: true,
        status: "Completed",
        receipt:
          data.TransactionReceipt || null,
        amount:
          data.TransactionAmount || null,
        phone:
          data.Msisdn || null,
        reference:
          data.TransactionReference || null
      });
    }

    if (
      response.ok &&
      data.TransactionStatus === "Pending"
    ) {
      return json(res, 200, {
        success: true,
        paid: false,
        status: "Pending"
      });
    }

    return json(res, 200, {
      success: true,
      paid: false,
      status:
        data.TransactionStatus ||
        "Unknown",
      resultCode:
        data.ResultCode || null,
      message:
        data.ResultDesc ||
        data.errorMessage ||
        "Payment not completed."
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
        "Unable to check payment status.",
      error:
        String(error.message || error)
    });
  }
};
