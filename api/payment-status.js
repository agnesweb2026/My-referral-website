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
    const { transaction_request_id, transaction_id } = req.body || {};

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
        paid: false,
        message:
          "Liparo payment settings are not configured on the server."
      });
    }

    const response = await fetch(
      "https://api.liparo.co.ke/v1/checktransaction",
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
          transaction_id: transactionId
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

    const status = String(
      data.status || ""
    ).toLowerCase();

    const paid =
      data.success === true &&
      status === "completed";

    console.log(
      "LIPARO_PAYMENT_STATUS",
      JSON.stringify({
        httpStatus: response.status,
        transaction_id: transactionId,
        status: data.status || null,
        paid: paid
      })
    );

    if (paid) {
      return json(res, 200, {
        success: true,
        paid: true,
        status: "Completed",
        transaction_id: transactionId,
        amount: data.amount || null,
        phone: data.phone || null,
        reference: data.reference || null,
        mpesa_receipt: data.mpesa_receipt || null,
        message:
          data.result_desc ||
          data.message ||
          "Payment completed successfully."
      });
    }

    if (
      status === "failed" ||
      status === "cancelled" ||
      status === "rejected"
    ) {
      return json(res, 200, {
        success: true,
        paid: false,
        status:
          data.status || "Failed",
        transaction_id: transactionId,
        message:
          data.result_desc ||
          data.message ||
          "Payment was not completed."
      });
    }

    return json(res, 200, {
      success: true,
      paid: false,
      status:
        data.status ||
        "Pending",
      transaction_id: transactionId,
      message:
        data.result_desc ||
        data.message ||
        "Payment is still pending."
    });

  } catch (error) {
    console.error(
      "LIPARO_STATUS_ERROR",
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
