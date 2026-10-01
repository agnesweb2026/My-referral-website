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

    const rawPhone = String(phone || "").replace(/\D/g, "");

    let mpesaPhone = rawPhone;

    if (/^07\d{8}$/.test(rawPhone)) {
      mpesaPhone = "254" + rawPhone.substring(1);
    }

    if (/^2547\d{8}$/.test(rawPhone)) {
      mpesaPhone = rawPhone;
    }

    if (!/^2547\d{8}$/.test(mpesaPhone)) {
      return json(res, 400, {
        success: false,
        message: "Enter a valid Safaricom M-PESA number.",
        validation: "phone"
      });
    }

    const cleanAmount = Number(amount);

    if (!Number.isInteger(cleanAmount) || cleanAmount < 1) {
      return json(res, 400, {
        success: false,
        message: "Invalid payment amount.",
        validation: "amount"
      });
    }

    const cleanReference = String(reference || "")
      .trim()
      .replace(/[^A-Za-z0-9_-]/g, "")
      .slice(0, 20);

    if (!cleanReference) {
      return json(res, 400, {
        success: false,
        message: "Missing payment reference.",
        validation: "reference"
      });
    }

    const secretKey = String(
      process.env.LIPARO_SECRET_KEY || ""
    ).trim();

    const passkey = String(
      process.env.LIPARO_PASSKEY || ""
    ).trim();

    const shortcode = String(
      process.env.LIPARO_SHORTCODE || ""
    ).trim();

    if (!secretKey || !passkey || !shortcode) {
      return json(res, 500, {
        success: false,
        message: "Liparo payment settings are not configured on the server."
      });
    }

    const response = await fetch(
      "https://api.liparo.co.ke/v1/initiatestk",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },

        body: JSON.stringify({
          secret_key: secretKey,
          passkey: passkey,
          shortcode: shortcode,
          amount: cleanAmount,
          phone: mpesaPhone,
          reference: cleanReference
        })
      }
    );

    const responseText = await response.text();

    let data;

    try {
      data = JSON.parse(responseText);
    } catch {
      data = {
        success: false,
        message:
          responseText ||
          "Liparo returned an invalid response."
      };
    }

    console.log(
      "LIPARO_STK_RESULT",
      JSON.stringify({
        httpStatus: response.status,
        amount: cleanAmount,
        reference: cleanReference,
        success: data.success === true,
        transaction_id: data.transaction_id || null
      })
    );

    if (
      response.ok &&
      data.success === true &&
      data.transaction_id
    ) {
      return json(res, 200, {
        success: true,

        message:
          data.message ||
          "M-PESA prompt sent successfully.",

        paymentId: data.transaction_id,

        transaction_request_id:
          data.transaction_id,

        transaction_id:
          data.transaction_id,

        status: "pending",

        reference: cleanReference
      });
    }

    return json(res, response.status || 500, {
      success: false,

      message:
        data.message ||
        "Liparo rejected the payment request.",

      code:
        data.error_code ||
        null,

      details: data
    });

  } catch (error) {

    console.error(
      "LIPARO_STK_ERROR",
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
