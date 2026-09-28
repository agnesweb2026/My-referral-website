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
      reference,
      description
    } = req.body || {};

    // Clean phone number
    const cleanPhone = String(phone || "")
      .replace(/\s+/g, "")
      .trim();

    // Convert amount to number
    const cleanAmount = Number(amount);

    // Clean reference
    const cleanReference = String(reference || "")
      .trim()
      .slice(0, 100);

    // Clean description
    const cleanDescription = String(
      description || "M-PESA payment"
    )
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

    // Read Neptune keys from Vercel Environment Variables
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

    // Current Unix timestamp
    const timestamp =
      Math.floor(Date.now() / 1000).toString();

    // IMPORTANT:
    // This exact object must be used when creating
    // the Neptune HMAC signature.
    const body = {
      phone: cleanPhone,
      amount: cleanAmount,
      reference: cleanReference,
      description: cleanDescription
    };

    const bodyString = JSON.stringify(body);

    // Neptune HMAC-SHA256 signature
    const signature = crypto
      .createHmac("sha256", secretKey)
      .update(
        timestamp + "." + bodyString
      )
      .digest("hex");

    // Send STK Push to Neptune
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
    const text = await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      data = {
        success: false,
        message:
          text || "Invalid Neptune Pay response."
      };
    }

    // Return Neptune's response to the website.
    // This also exposes the HTTP status so we can
    // diagnose a validation error.
    return json(res, response.status, {
      ...data,
      neptuneHttpStatus: response.status
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
        process.env.NODE_ENV === "development"
          ? String(error.message || error)
          : undefined
    });
  }
};
