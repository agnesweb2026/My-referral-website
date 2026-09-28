const crypto = require("crypto");

function json(res, status, data) {
  res.status(status).setHeader("Content-Type", "application/json");
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

    const cleanPhone = String(phone || "")
      .replace(/\s+/g, "");

    const cleanAmount = Number(amount);

    const cleanReference = String(reference || "")
      .trim()
      .slice(0, 100);

    const cleanDescription = String(
      description || "M-PESA payment"
    )
      .trim()
      .slice(0, 100);

    if (!/^2547\d{8}$/.test(cleanPhone)) {
      return json(res, 400, {
        success: false,
        message:
          "Enter a valid Kenyan M-PESA number in 2547XXXXXXXX format."
      });
    }

    if (
      !Number.isInteger(cleanAmount) ||
      cleanAmount < 1
    ) {
      return json(res, 400, {
        success: false,
        message: "Invalid amount."
      });
    }

    if (!cleanReference) {
      return json(res, 400, {
        success: false,
        message: "Missing payment reference."
      });
    }

    const publicKey =
      process.env.NEPTUNE_PUBLIC_KEY;

    const secretKey =
      process.env.NEPTUNE_SECRET_KEY;

    if (!publicKey || !secretKey) {
      return json(res, 500, {
        success: false,
        message:
          "Neptune Pay keys are not configured."
      });
    }

    const timestamp =
      Math.floor(Date.now() / 1000).toString();

    const body = {
      phone: cleanPhone,
      amount: cleanAmount,
      reference: cleanReference,
      description: cleanDescription
    };

    const signature = crypto
      .createHmac("sha256", secretKey)
      .update(
        timestamp +
        "." +
        JSON.stringify(body)
      )
      .digest("hex");

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

        body: JSON.stringify(body)
      }
    );

    const text = await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      data = {
        success: false,
        message:
          text ||
          "Invalid Neptune Pay response."
      };
    }

    return json(
      res,
      response.status,
      data
    );

  } catch (error) {

    console.error(
      "Neptune STK Push error:",
      error
    );

    return json(res, 500, {
      success: false,
      message:
        "Unable to start the M-PESA prompt."
    });
  }
};
