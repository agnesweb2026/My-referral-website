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
    const { phone, amount, reference } = req.body || {};

    // -----------------------------
    // PHONE
    // -----------------------------
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

    // -----------------------------
    // AMOUNT
    // -----------------------------
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

    // -----------------------------
    // REFERENCE
    // -----------------------------
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

    // -----------------------------
    // NEPTUNE KEYS
    // -----------------------------
    const publicKey = String(
      process.env.NEPTUNE_PUBLIC_KEY || ""
    ).trim();

    const secretKey = String(
      process.env.NEPTUNE_SECRET_KEY || ""
    ).trim();

    if (!publicKey || !secretKey) {
      return json(res, 500, {
        success: false,
        message:
          "Neptune Pay keys are not configured on the server."
      });
    }

    // -----------------------------
    // EXACT NEPTUNE REQUEST
    // -----------------------------
    const timestamp =
      Math.floor(Date.now() / 1000).toString();

    const body = {
      phone: mpesaPhone,
      amount: cleanAmount,
      reference: cleanReference
    };

    const bodyString = JSON.stringify(body);

    const signature = crypto
      .createHmac("sha256", secretKey)
      .update(
        timestamp + "." + bodyString
      )
      .digest("hex");

    // -----------------------------
    // SEND TO NEPTUNE
    // -----------------------------
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

    // -----------------------------
    // READ NEPTUNE RESPONSE
    // -----------------------------
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

    // IMPORTANT:
    // This appears in Vercel Runtime Logs.
    // It does NOT expose the secret key.
    console.log(
      "NEPTUNE_STK_RESULT",
      JSON.stringify({
        httpStatus: response.status,
        phone: mpesaPhone,
        amount: cleanAmount,
        reference: cleanReference,
        response: data
      })
    );

    // -----------------------------
    // SUCCESS
    // -----------------------------
    if (
      response.ok &&
      data.success === true
    ) {
      return json(res, 200, {
        success: true,
        message:
          data.message ||
          "M-PESA prompt sent successfully.",
        paymentId:
          data.paymentId || null,
        status:
          data.status || "pending",
        reference:
          data.reference ||
          cleanReference
      });
    }

    // -----------------------------
    // NEPTUNE ERROR
    // -----------------------------
    return json(res, response.status, {
      success: false,

      message:
        data.message ||
        data.error ||
        "Neptune Pay rejected the payment request.",

      validation:
        data.validation || null,

      code:
        data.code || null,

      errors:
        data.errors || null,

      details:
        data.details || null,

      neptuneHttpStatus:
        response.status
    });

  } catch (error) {
    console.error(
      "NEPTUNE_STK_ERROR",
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
