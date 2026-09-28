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

    // Clean phone
    const cleanPhone = String(phone || "")
      .replace(/\s+/g, "")
      .trim();

    // Clean amount
    const cleanAmount = Number(amount);

    // Clean reference
    const cleanReference = String(reference || "")
      .trim()
      .slice(0, 100);

    // Validate phone
    if (!/^2547\d{8}$/.test(cleanPhone)) {
      return json(res, 400, {
        success: false,
        message:
          "Enter a valid Safaricom M-PESA number, for example 254712345678.",
        validation: "phone"
      });
    }

    // Validate amount
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

    // Validate reference
    if (!cleanReference) {
      return json(res, 400, {
        success: false,
        message: "Missing payment reference.",
        validation: "reference"
      });
    }

    // Neptune keys
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

    // Timestamp
    const timestamp =
      Math.floor(Date.now() / 1000).toString();

    /*
      IMPORTANT:
      Neptune documentation uses only:
      phone
      amount
      reference
    */

    const body = {
      phone: cleanPhone,
      amount: cleanAmount,
      reference: cleanReference
    };

    const bodyString =
      JSON.stringify(body);

    // HMAC-SHA256
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

    // Send STK Push
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

    // Read Neptune response
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
          "Invalid Neptune Pay response."
      };
    }

    // Return safe response
    return json(res, response.status, {
      success:
        Boolean(data.success),

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
