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
    const { phone, amount, reference } = req.body || {};

    // =============================
    // PHONE
    // =============================
    const rawPhone = String(phone || "").replace(/\D/g, "");

    let mpesaPhone = rawPhone;

    // 0712345678 -> 254712345678
    if (/^07\d{8}$/.test(rawPhone)) {
      mpesaPhone = "254" + rawPhone.substring(1);
    }

    // 254712345678
    if (/^2547\d{8}$/.test(rawPhone)) {
      mpesaPhone = rawPhone;
    }

    if (!/^2547\d{8}$/.test(mpesaPhone)) {
      return json(res, 400, {
        success: false,
        message:
          "Enter a valid Safaricom M-PESA number, for example 0712345678.",
        validation: "phone"
      });
    }

    // =============================
    // AMOUNT
    // =============================
    const cleanAmount = Number(amount);

    if (!Number.isInteger(cleanAmount) || cleanAmount < 1) {
      return json(res, 400, {
        success: false,
        message: "Invalid payment amount.",
        validation: "amount"
      });
    }

    // =============================
    // REFERENCE
    // UnifiedPay recommends 12 chars
    // or fewer.
    // =============================
    const cleanReference = String(reference || "")
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

    // =============================
    // UNIFIEDPAY CREDENTIALS
    // These remain on the server.
    // =============================
    const consumerKey = String(
      process.env.UNIFIEDPAY_CONSUMER_KEY || ""
    ).trim();

    const consumerSecret = String(
      process.env.UNIFIEDPAY_CONSUMER_SECRET || ""
    ).trim();

    const shortcode = String(
      process.env.UNIFIEDPAY_SHORTCODE || ""
    ).trim();

    if (!consumerKey || !consumerSecret) {
      return json(res, 500, {
        success: false,
        message:
          "UnifiedPay credentials are not configured on the server."
      });
    }

    if (!shortcode) {
      return json(res, 500, {
        success: false,
        message:
          "UnifiedPay shortcode is not configured on the server."
      });
    }

    // =============================
    // UNIFIEDPAY STK PUSH
    // =============================
    const url =
      "https://unifiedpay.co.ke/auth/cred/" +
      encodeURIComponent(consumerKey) +
      "/" +
      encodeURIComponent(consumerSecret) +
      "/sendstk";

    const requestBody = {
      amount: cleanAmount,
      msisdn: mpesaPhone,
      reference: cleanReference
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    // =============================
    // READ RESPONSE
    // =============================
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

    // =============================
    // SERVER LOG
    // Does NOT log consumer secret.
    // =============================
    console.log(
      "UNIFIEDPAY_STK_RESULT",
      JSON.stringify({
        httpStatus: response.status,
        phone: mpesaPhone,
        amount: cleanAmount,
        reference: cleanReference,
        response: data
      })
    );

    // =============================
    // SUCCESS
    // =============================
    if (
      response.ok &&
      data.ResponseCode === "0" &&
      data.success === true
    ) {
      return json(res, 200, {
        success: true,
        message:
          data.message ||
          "M-PESA prompt sent successfully.",

        paymentId:
          data.transaction_request_id || null,

        transaction_request_id:
          data.transaction_request_id || null,

        MerchantRequestID:
          data.MerchantRequestID || null,

        CheckoutRequestID:
          data.CheckoutRequestID || null,

        status: "pending",

        reference: cleanReference
      });
    }

    // =============================
    // UNIFIEDPAY ERROR
    // =============================
    return json(res, response.status || 500, {
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
    });

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
        String(error.message || error)
    });
  }
};
