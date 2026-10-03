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
    const {
      phone,
      amount,
      reference
    } = req.body || {};

    // =========================
    // CLEAN PHONE NUMBER
    // =========================
    const rawPhone = String(phone || "")
      .replace(/\D/g, "");

    let mpesaPhone = rawPhone;

    // 0712345678 -> 254712345678
    if (/^07\d{8}$/.test(rawPhone)) {
      mpesaPhone =
        "254" + rawPhone.substring(1);
    }

    // 254712345678
    if (/^2547\d{8}$/.test(rawPhone)) {
      mpesaPhone = rawPhone;
    }

    if (!/^2547\d{8}$/.test(mpesaPhone)) {
      return json(res, 400, {
        success: false,
        message:
          "Enter a valid Safaricom M-PESA number.",
        validation: "phone"
      });
    }

    // =========================
    // CHECK AMOUNT
    // =========================
    const cleanAmount = Number(amount);

    if (
      !Number.isInteger(cleanAmount) ||
      cleanAmount < 1
    ) {
      return json(res, 400, {
        success: false,
        message: "Invalid payment amount.",
        validation: "amount"
      });
    }

    // =========================
    // PAYMENT REFERENCE
    // =========================
    const cleanReference = String(
      reference || ""
    )
      .trim()
      .replace(/[^A-Za-z0-9_-]/g, "")
      .slice(0, 12);

    if (!cleanReference) {
      return json(res, 400, {
        success: false,
        message: "Missing payment reference.",
        validation: "reference"
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
        message:
          "UnifiedPay credentials are not configured on the server."
      });
    }

    // =========================
    // UNIFIEDPAY STK ENDPOINT
    // =========================
    const url =
      "https://unifiedpay.co.ke/auth/cred/" +
      encodeURIComponent(consumerKey) +
      "/" +
      encodeURIComponent(consumerSecret) +
      "/sendstk";

    // =========================
    // SEND STK PUSH
    // =========================
    const response = await fetch(url, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },

      body: JSON.stringify({
        amount: cleanAmount,
        msisdn: mpesaPhone,
        reference: cleanReference
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
        errorMessage:
          responseText ||
          "UnifiedPay returned an invalid response."
      };
    }

    console.log(
      "UNIFIEDPAY_STK_RESULT",
      JSON.stringify({
        httpStatus: response.status,
        amount: cleanAmount,
        phone: mpesaPhone,
        reference: cleanReference,
        ResponseCode:
          data.ResponseCode || null,
        success:
          data.success === true,
        transaction_request_id:
          data.transaction_request_id || null
      })
    );

    // =========================
    // SUCCESS
    // =========================
    if (
      response.ok &&
      (
        data.success === true ||
        String(data.ResponseCode) === "0"
      ) &&
      data.transaction_request_id
    ) {
      return json(res, 200, {
        success: true,

        message:
          data.message ||
          "M-PESA prompt sent successfully.",

        paymentId:
          data.transaction_request_id,

        transaction_request_id:
          data.transaction_request_id,

        transaction_id:
          data.transaction_request_id,

        status: "pending",

        reference: cleanReference
      });
    }

    // =========================
    // ERROR
    // =========================
    return json(
      res,
      response.status || 500,
      {
        success: false,

        message:
          data.errorMessage ||
          data.message ||
          "UnifiedPay rejected the payment request.",

        code:
          data.ResultCode ||
          data.ResponseCode ||
          null,

        details: data
      }
    );

  } catch (error) {

    console.error(
      "UNIFIEDPAY_STK_ERROR",
      error
    );

    return json(res, 500, {
      success: false,

      message:
        "Unable to start the M-PESA prompt.",

      error:
        String(
          error.message || error
        )
    });
  }
};
