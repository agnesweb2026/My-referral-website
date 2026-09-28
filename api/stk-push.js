const crypto = require("crypto");

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

    // =========================================
    // CLEAN PHONE NUMBER
    // =========================================

    const cleanPhone = String(phone || "")
      .replace(/\D/g, "");

    let mpesaPhone = cleanPhone;

    // 07XXXXXXXX -> 2547XXXXXXXX
    if (/^07\d{8}$/.test(cleanPhone)) {
      mpesaPhone =
        "254" + cleanPhone.substring(1);
    }

    // 2547XXXXXXXX
    if (/^2547\d{8}$/.test(cleanPhone)) {
      mpesaPhone = cleanPhone;
    }

    // =========================================
    // VALIDATE SAFARICOM NUMBER
    // =========================================

    if (!/^2547\d{8}$/.test(mpesaPhone)) {
      return json(res, 400, {
        success: false,
        message:
          "Enter a valid Safaricom M-PESA number, for example 0712345678.",
        validation: "phone"
      });
    }

    // =========================================
    // AMOUNT
    // =========================================

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

    // =========================================
    // REFERENCE
    // =========================================

    const cleanReference = String(reference || "")
      .trim()
      .replace(/[^A-Za-z0-9_-]/g, "")
      .slice(0, 50);

    if (!cleanReference) {
      return json(res, 400, {
        success: false,
        message: "Missing payment reference.",
        validation: "reference"
      });
    }

    // =========================================
    // NEPTUNE KEYS
    // =========================================

    const publicKey =
      process.env.NEPTUNE_PUBLIC_KEY;

    const secretKey =
      process.env.NEPTUNE_SECRET_KEY;

    if (!publicKey || !secretKey) {
      return json(res, 500, {
        success: false,
        message:
          "Neptune Pay keys are not configured on the server."
      });
    }

    // =========================================
    // TIMESTAMP
    // =========================================

    const timestamp =
      Math.floor(Date.now() / 1000).toString();

    // =========================================
    // NEPTUNE BODY
    // =========================================
    // Keep this EXACTLY as documented:
    // phone, amount, reference

    const body = {
      phone: mpesaPhone,
      amount: cleanAmount,
      reference: cleanReference
    };

    const bodyString =
      JSON.stringify(body);

    // =========================================
    // HMAC SHA256 SIGNATURE
    // =========================================

    const signature =
      crypto
        .createHmac(
          "sha256",
          secretKey
        )
        .update(
          timestamp + "." + bodyString
        )
        .digest("hex");

    // =========================================
    // SEND STK PUSH
    // =========================================

    const response = await fetch(
      "https://api.neptunepay.co.ke/api/v1/payments/stk-push",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "x-public-key": publicKey,
          "x-signature": signature,
          "x-timestamp": timestamp
        },

        body: bodyString
      }
    );

    // =========================================
    // READ NEPTUNE RESPONSE
    // =========================================

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
          "Neptune returned an invalid response."
      };
    }

    // =========================================
    // RETURN RESULT TO WEBSITE
    // =========================================

    return json(res, response.status, {
      success:
        data.success === true,

      message:
        data.message ||
        data.error ||
        "Payment request was rejected.",

      paymentId:
        data.paymentId ||
        null,

      status:
        data.status ||
        null,

      reference:
        data.reference ||
        cleanReference,

      validation:
        data.validation ||
        null,

      errors:
        data.errors ||
        null,

      details:
        data.details ||
        null,

      neptuneHttpStatus:
        response.status
    });

  } catch (error) {

    console.error(
      "Neptune STK Push error:",
      error
    );

    return json(res, 500, {
      success: false,
      message:
        "Unable to start the M-PESA prompt.",
      error:
        String(
          error.message ||
          error
        )
    });
  }
};
