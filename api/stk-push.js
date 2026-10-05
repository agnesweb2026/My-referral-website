const { query, ensurePaymentTable } = require("./db");

function json(res, status, data) {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  return res.end(JSON.stringify(data));
}

// =====================================================
// DUPLICATE PROTECTION
// =====================================================

const recentRequests = new Map();
const COOLDOWN_MS = 30 * 1000;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return json(res, 405, {
      success: false,
      message: "Method not allowed"
    });
  }

  let cleanReference = "";
  let requestKey = "";

  try {
    await ensurePaymentTable();

    const body = req.body || {};

    const phone = body.phone;
    const amount = body.amount;
    const reference = body.reference;

    // =====================================================
    // PHONE
    // =====================================================

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

    // =====================================================
    // AMOUNT
    // =====================================================

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

    // =====================================================
    // REFERENCE
    // =====================================================

    cleanReference = String(reference || "")
      .trim()
      .replace(/[^A-Za-z0-9_-]/g, "")
      .slice(0, 100);

    if (!cleanReference) {
      return json(res, 400, {
        success: false,
        message: "Missing payment reference.",
        validation: "reference"
      });
    }

    requestKey =
      mpesaPhone +
      "|" +
      cleanAmount +
      "|" +
      cleanReference;

    // =====================================================
    // DUPLICATE PROTECTION
    // =====================================================

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
              (now - previousRequest)) /
              1000
          )
      });
    }

    recentRequests.set(
      requestKey,
      now
    );

    // Cleanup old requests
    if (recentRequests.size > 5000) {
      for (const [key, timestamp] of recentRequests) {
        if (
          now - timestamp >
          COOLDOWN_MS
        ) {
          recentRequests.delete(key);
        }
      }
    }

    // =====================================================
    // CHECK DATABASE
    // =====================================================

    const existingPayment =
      await query(
        `
        SELECT
          id,
          amount,
          phone,
          status,
          transaction_request_id,
          transaction_id
        FROM payments
        WHERE reference = $1
        LIMIT 1
        `,
        [cleanReference]
      );

    if (existingPayment.rows.length > 0) {
      const existing =
        existingPayment.rows[0];

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

      const existingStatus =
        String(existing.status || "")
          .toLowerCase();

      const existingTransaction =
        existing.transaction_id ||
        existing.transaction_request_id;

      // Already completed
      if (
        existingStatus === "completed" ||
        existingStatus === "complete" ||
        existingStatus === "paid" ||
        existingStatus === "successful" ||
        existingStatus === "success"
      ) {
        recentRequests.delete(
          requestKey
        );

        return json(res, 200, {
          success: true,
          paid: true,
          message:
            "Payment already completed.",

          paymentId:
            existingTransaction,

          transaction_id:
            existing.transaction_id ||
            existingTransaction,

          transaction_request_id:
            existing.transaction_request_id ||
            existingTransaction,

          status: "Completed",

          reference:
            cleanReference
        });
      }

      // Already pending
      if (
        existingStatus === "pending" &&
        existingTransaction
      ) {
        recentRequests.delete(
          requestKey
        );

        return json(res, 200, {
          success: true,

          message:
            "M-PESA prompt is already pending. Please check your phone.",

          paymentId:
            existingTransaction,

          transaction_id:
            existing.transaction_id ||
            existingTransaction,

          transaction_request_id:
            existing.transaction_request_id ||
            existingTransaction,

          status: "Pending",

          reference:
            cleanReference
        });
      }
    }

    // =====================================================
    // PAYLOR CREDENTIALS
    // =====================================================

    const paylorApiKey =
      String(
        process.env.PAYLOR_API_KEY || ""
      ).trim();

    const paylorChannelId =
      String(
        process.env.PAYLOR_CHANNEL_ID || ""
      ).trim();

    if (
      !paylorApiKey ||
      !paylorChannelId
    ) {
      recentRequests.delete(
        requestKey
      );

      return json(res, 500, {
        success: false,
        message:
          "Paylor payment credentials are not configured on the server."
      });
    }

    // =====================================================
    // CALLBACK URL
    // =====================================================

    const host =
      req.headers.host ||
      process.env.VERCEL_URL ||
      "";

    let callbackUrl;

    if (host) {
      callbackUrl =
        "https://" +
        String(host)
          .replace(/^https?:\/\//, "") +
        "/api/payment-callback";
    }

    // =====================================================
    // SAVE PAYMENT AS PENDING
    // =====================================================

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
          transaction_request_id = NULL,
          transaction_id = NULL,
          transaction_code = NULL,
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

    // =====================================================
    // PAYLOR STK PUSH
    // =====================================================

    const payload = {
      phone: mpesaPhone,
      amount: cleanAmount,
      reference: cleanReference,
      channelId: paylorChannelId
    };

    if (callbackUrl) {
      payload.callbackUrl =
        callbackUrl;
    }

    const response =
      await fetch(
        "https://api.paylorke.com/api/v1/merchants/payments/stk-push",
        {
          method: "POST",

          headers: {
            Authorization:
              "Bearer " +
              paylorApiKey,

            "Content-Type":
              "application/json",

            Accept:
              "application/json"
          },

          body:
            JSON.stringify(payload)
        }
      );

    // =====================================================
    // READ PAYLOR RESPONSE
    // =====================================================

    const responseText =
      await response.text();

    let data = {};

    try {
      data =
        responseText
          ? JSON.parse(responseText)
          : {};
    } catch {
      data = {
        message:
          responseText ||
          "Paylor returned an invalid response."
      };
    }

    console.log(
      "PAYLOR_STK_RESULT",
      JSON.stringify({
        httpStatus:
          response.status,

        reference:
          cleanReference,

        status:
          data.status ||
          null,

        transactionId:
          data.transactionId ||
          null
      })
    );

    // =====================================================
    // PAYLOR SUCCESS
    // =====================================================

    if (
      response.ok &&
      data.transactionId
    ) {
      const transactionId =
        String(
          data.transactionId
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
          transactionId
        ]
      );

      recentRequests.delete(
        requestKey
      );

      return json(res, 200, {
        success: true,

        message:
          "M-PESA prompt sent successfully.",

        paymentId:
          transactionId,

        transaction_id:
          transactionId,

        transaction_request_id:
          transactionId,

        status:
          data.status ||
          "SENT",

        reference:
          cleanReference
      });
    }

    // =====================================================
    // PAYLOR REJECTED
    // =====================================================

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
      response.status >= 400
        ? response.status
        : 502,
      {
        success: false,

        message:
          data.message ||
          data.error?.message ||
          "Paylor rejected the payment request.",

        code:
          data.error?.code ||
          data.code ||
          null
      }
    );

  } catch (error) {

    console.error(
      "PAYLOR_STK_ERROR",
      error
    );

    if (requestKey) {
      recentRequests.delete(
        requestKey
      );
    }

    if (cleanReference) {
      try {
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
      } catch (dbError) {
        console.error(
          "PAYMENT_DB_UPDATE_ERROR",
          dbError
        );
      }
    }

    return json(res, 500, {
      success: false,

      message:
        "Unable to start the M-PESA prompt."
    });
  }
};
