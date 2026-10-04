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
      .slice(0, 12);

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

    // Cleanup old entries
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
          transaction_request_id
        FROM payments
        WHERE reference = $1
        LIMIT 1
        `,
        [cleanReference]
      );

    if (existingPayment.rows.length > 0) {
      const existing =
        existingPayment.rows[0];

      // Same reference cannot use another amount
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

      // Don't send another prompt while pending
      if (
        existingStatus === "pending" &&
        existing.transaction_request_id
      ) {
        recentRequests.delete(
          requestKey
        );

        return json(res, 409, {
          success: false,

          message:
            "This payment request is already pending. Please check your M-PESA phone.",

          paymentId:
            existing.transaction_request_id,

          transaction_request_id:
            existing.transaction_request_id,

          transaction_id:
            existing.transaction_request_id,

          status: "Pending",

          reference:
            cleanReference
        });
      }
    }

    // =====================================================
    // LIPARO CREDENTIALS
    // =====================================================

    const liparoSecret =
      String(
        process.env.LIPARO_SECRET || ""
      ).trim();

    const liparoPasskey =
      String(
        process.env.LIPARO_PASSKEY || ""
      ).trim();

    const liparoShortcode =
      String(
        process.env.LIPARO_SHORTCODE || ""
      ).trim();

    if (
      !liparoSecret ||
      !liparoPasskey ||
      !liparoShortcode
    ) {
      recentRequests.delete(
        requestKey
      );

      return json(res, 500, {
        success: false,
        message:
          "Liparo payment credentials are not configured on the server."
      });
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
    // LIPARO STK PUSH
    // =====================================================

    const url =
      "https://api.liparo.co.ke/v1/initiatestk";

    let response;

    try {
      response = await fetch(
        url,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",
            "Accept":
              "application/json"
          },

          body: JSON.stringify({
            secret_key:
              liparoSecret,

            passkey:
              liparoPasskey,

            shortcode:
              liparoShortcode,

            amount:
              cleanAmount,

            phone:
              mpesaPhone,

            reference:
              cleanReference
          })
        }
      );
    } catch (networkError) {
      console.error(
        "LIPARO_NETWORK_ERROR",
        networkError
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

      return json(res, 502, {
        success: false,

        message:
          "Unable to connect to the M-PESA payment service. Please try again shortly.",

        code:
          "LIPARO_CONNECTION_ERROR"
      });
    }

    // =====================================================
    // READ RESPONSE
    // =====================================================

    const responseText =
      await response.text();

    let data = {};

    try {
      data = responseText
        ? JSON.parse(responseText)
        : {};
    } catch {
      data = {
        rawResponse:
          responseText
      };
    }

    console.log(
      "LIPARO_STK_RESULT",
      JSON.stringify({
        httpStatus:
          response.status,

        amount:
          cleanAmount,

        phone:
          mpesaPhone,

        reference:
          cleanReference,

        success:
          data.success === true,

        transaction_id:
          data.transaction_id ||
          null
      })
    );

    // =====================================================
    // SUCCESS
    // =====================================================

    if (
      response.ok &&
      data.success === true &&
      data.transaction_id
    ) {
      const transactionId =
        String(
          data.transaction_id
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

      return json(res, 200, {
        success: true,

        message:
          data.message ||
          "M-PESA prompt sent successfully.",

        paymentId:
          transactionId,

        transaction_request_id:
          transactionId,

        transaction_id:
          transactionId,

        status:
          "Pending",

        reference:
          cleanReference
      });
    }

    // =====================================================
    // TEMPORARY LIPARO ERROR
    // =====================================================

    if (
      response.status === 429 ||
      response.status === 502 ||
      response.status === 503 ||
      response.status === 504
    ) {
      console.error(
        "LIPARO_TEMPORARY_ERROR",
        JSON.stringify({
          httpStatus:
            response.status,

          reference:
            cleanReference,

          response:
            data
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

      return json(res, 502, {
        success: false,

        message:
          "M-PESA service is temporarily unavailable. Please try again in a few seconds.",

        code:
          "LIPARO_TEMPORARY_ERROR"
      });
    }

    // =====================================================
    // REJECTED
    // =====================================================

    console.error(
      "LIPARO_STK_REJECTED",
      JSON.stringify({
        httpStatus:
          response.status,

        errorCode:
          data.error_code ||
          null,

        message:
          data.message ||
          null,

        reference:
          cleanReference
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
      response.status >= 400
        ? response.status
        : 500,
      {
        success: false,

        message:
          data.message ||
          "Liparo rejected the payment request.",

        code:
          data.error_code ||
          null
      }
    );

  } catch (error) {
    console.error(
      "LIPARO_STK_ERROR",
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
