const { query, ensurePaymentTable } = require("./db");

function json(res, status, data) {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  return res.end(JSON.stringify(data));
}

const recentRequests = new Map();
const COOLDOWN_MS = 30 * 1000;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return json(res, 405, {
      success: false,
      message: "Method not allowed"
    });
  }

  try {
    // =========================
    // DATABASE
    // =========================
    await ensurePaymentTable();

    const {
      phone,
      amount,
      reference
    } = req.body || {};

    // =========================
    // PHONE
    // =========================
    const rawPhone = String(phone || "")
      .replace(/\D/g, "");

    let mpesaPhone = rawPhone;

    if (/^07\d{8}$/.test(rawPhone)) {
      mpesaPhone =
        "254" + rawPhone.substring(1);
    }

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
    // AMOUNT
    // =========================
    const cleanAmount = Number(amount);

    if (
      !Number.isInteger(cleanAmount) ||
      cleanAmount < 1 ||
      cleanAmount > 150000
    ) {
      return json(res, 400, {
        success: false,
        message: "Invalid payment amount.",
        validation: "amount"
      });
    }

    // =========================
    // REFERENCE
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
    // DUPLICATE PROTECTION
    // =========================
    const requestKey =
      mpesaPhone +
      "|" +
      cleanAmount +
      "|" +
      cleanReference;

    const now = Date.now();

    const previousRequest =
      recentRequests.get(requestKey);

    if (
      previousRequest &&
      now - previousRequest < COOLDOWN_MS
    ) {
      return json(res, 429, {
        success: false,
        message:
          "A payment request was already sent. Please wait before trying again.",
        retry_after_seconds:
          Math.ceil(
            (COOLDOWN_MS -
              (now - previousRequest)) / 1000
          )
      });
    }

    recentRequests.set(
      requestKey,
      now
    );

    // =========================
    // MEMORY CLEANUP
    // =========================
    if (recentRequests.size > 5000) {
      for (const [
        key,
        timestamp
      ] of recentRequests) {
        if (
          now - timestamp >
          COOLDOWN_MS
        ) {
          recentRequests.delete(key);
        }
      }
    }

    // =========================
    // CHECK DATABASE
    // =========================
    const existingPayment =
      await query(
        `
        SELECT
          id,
          amount,
          phone,
          status,
          transaction_request_id
        FROM payments
        WHERE reference = $1
        LIMIT 1
        `,
        [cleanReference]
      );

    if (
      existingPayment.rows.length > 0
    ) {
      const existing =
        existingPayment.rows[0];

      // Same reference cannot use
      // a different amount.
      if (
        Number(existing.amount) !==
        cleanAmount
      ) {
        recentRequests.delete(
          requestKey
        );

        return json(res, 409, {
          success: false,
          message:
            "This payment reference is already linked to another amount."
        });
      }

      // Do not send another prompt
      // while one is still pending.
      if (
        String(existing.status).toLowerCase() ===
        "pending"
      ) {
        recentRequests.delete(
          requestKey
        );

        return json(res, 409, {
          success: false,
          message:
            "This payment request is already pending. Please check your M-PESA phone.",
          paymentId:
            existing.transaction_request_id || null,
          transaction_request_id:
            existing.transaction_request_id || null,
          status: "Pending",
          reference:
            cleanReference
        });
      }
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
      recentRequests.delete(
        requestKey
      );

      return json(res, 500, {
        success: false,
        message:
          "UnifiedPay credentials are not configured on the server."
      });
    }

    // Part 2 continues...
  // =========================
// UNIFIEDPAY STK URL
// =========================
const url =
  "https://unifiedpay.co.ke/auth/cred/" +
  encodeURIComponent(consumerKey) +
  "/" +
  encodeURIComponent(consumerSecret) +
  "/sendstk";

// =========================
// CREATE / UPDATE PAYMENT
// =========================
if (
  existingPayment.rows.length === 0
) {
  await query(
    `
    INSERT INTO payments
    (
      reference,
      amount,
      phone,
      status
    )
    VALUES
    ($1, $2, $3, 'pending')
    `,
    [
      cleanReference,
      cleanAmount,
      mpesaPhone
    ]
  );
} else {
  await query(
    `
    UPDATE payments
    SET
      phone = $2,
      amount = $3,
      status = 'pending',
      updated_at = NOW()
    WHERE reference = $1
    `,
    [
      cleanReference,
      mpesaPhone,
      cleanAmount
    ]
  );
}

// =========================
// SEND STK PROMPT
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
  data = JSON.parse(
    responseText
  );
} catch {
  data = {
    success: false,
    errorMessage:
      responseText ||
      "UnifiedPay returned an invalid response."
  };
}

// =========================
// SUCCESS
// =========================
if (
  response.ok &&
  String(data.ResponseCode) === "0" &&
  data.transaction_request_id
) {
  const transactionRequestId =
    String(
      data.transaction_request_id
    );

  await query(
    `
    UPDATE payments
    SET
      status = 'pending',
      transaction_request_id = $2,
      transaction_id = $2,
      updated_at = NOW()
    WHERE reference = $1
    `,
    [
      cleanReference,
      transactionRequestId
    ]
  );

  console.log(
    "UNIFIEDPAY_STK_SUCCESS",
    JSON.stringify({
      amount: cleanAmount,
      reference: cleanReference,
      transaction_request_id:
        transactionRequestId
    })
  );

  return json(res, 200, {
    success: true,

    message:
      data.message ||
      "M-PESA prompt sent successfully.",

    paymentId:
      transactionRequestId,

    transaction_request_id:
      transactionRequestId,

    transaction_id:
      transactionRequestId,

    status: "Pending",

    reference:
      cleanReference
  });
}

// =========================
// REJECTED
// =========================
console.error(
  "UNIFIEDPAY_STK_REJECTED",
  JSON.stringify({
    httpStatus:
      response.status,
    ResponseCode:
      data.ResponseCode || null,
    errorMessage:
      data.errorMessage || null
  })
);

await query(
  `
  UPDATE payments
  SET
    status = 'failed',
    updated_at = NOW()
  WHERE reference = $1
  `,
  [cleanReference]
);

recentRequests.delete(
  requestKey
);

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
      null
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
        "Unable to start the M-PESA prompt."
    });
  }
};
