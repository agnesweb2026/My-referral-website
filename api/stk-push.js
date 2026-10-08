const crypto = require("crypto");

const {
  query,
  ensurePaymentTable
} = require("./db");


/*
=========================================================
PAYLOR STK PUSH
PAYMENT PROTECTION
=========================================================
*/

module.exports = async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }


  /*
  =======================================================
  PAYLOR CREDENTIALS
  =======================================================
  */

  const apiKey =
    process.env.PAYLOR_API_KEY;

  const channelId =
    process.env.PAYLOR_CHANNEL_ID;


  if (!apiKey || !channelId) {
    return res.status(500).json({
      success: false,
      message:
        "Paylor credentials are not configured on the server"
    });
  }


  /*
  =======================================================
  DATABASE
  =======================================================
  */

  try {

    await ensurePaymentTable();

  } catch (error) {

    console.error(
      "DATABASE SETUP ERROR:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Payment database is not available"
    });
  }


  /*
  =======================================================
  REQUEST DATA
  =======================================================
  */

  const body =
    req.body || {};

  const phone =
    body.phone;

  const amount =
    Number(body.amount);

  const reference =
    String(
      body.reference || ""
    ).trim();


  /*
  =======================================================
  BASIC VALIDATION
  =======================================================
  */

  if (!phone) {
    return res.status(400).json({
      success: false,
      message:
        "M-PESA phone number is required"
    });
  }


  if (!Number.isFinite(amount)) {
    return res.status(400).json({
      success: false,
      message:
        "A valid payment amount is required"
    });
  }


  /*
  =======================================================
  ALLOWED PACKAGE AMOUNTS
  =======================================================
  */

  const ALLOWED_AMOUNTS = [
    80,
    100,
    150,
    200,
    250,
    300
  ];


  const paymentAmount =
    Math.round(amount);


  if (
    !ALLOWED_AMOUNTS.includes(
      paymentAmount
    )
  ) {

    return res.status(400).json({
      success: false,
      message:
        "Invalid payment package"
    });
  }


  if (!reference) {
    return res.status(400).json({
      success: false,
      message:
        "Payment reference is required"
    });
  }


  /*
  =======================================================
  CLEAN REFERENCE
  =======================================================
  */

  const cleanReference =
    reference
      .replace(
        /[^A-Za-z0-9_-]/g,
        ""
      )
      .slice(0, 100);


  if (!cleanReference) {
    return res.status(400).json({
      success: false,
      message:
        "Invalid payment reference"
    });
  }


  /*
  =======================================================
  PHONE NORMALIZATION
  =======================================================
  */

  let cleanPhone =
    String(phone)
      .replace(/\D/g, "")
      .trim();


  /*
  01XXXXXXXX / 07XXXXXXXX
  */

  if (
    cleanPhone.startsWith("0") &&
    cleanPhone.length === 10
  ) {

    cleanPhone =
      "254" +
      cleanPhone.substring(1);
  }


  /*
  1XXXXXXXX / 7XXXXXXXX
  */

  if (
    (
      cleanPhone.startsWith("1") ||
      cleanPhone.startsWith("7")
    ) &&
    cleanPhone.length === 9
  ) {

    cleanPhone =
      "254" +
      cleanPhone;
  }


  /*
  =======================================================
  FINAL SAFARICOM VALIDATION
  =======================================================
  */

  if (
    !/^254(1|7)\d{8}$/.test(
      cleanPhone
    )
  ) {

    return res.status(400).json({
      success: false,
      message:
        "Enter a valid Safaricom M-PESA number starting with 01 or 07"
    });
  }


  /*
  =======================================================
  CLIENT IP
  =======================================================
  */

  let clientIp =
    "unknown";

  try {

    const forwarded =
      req.headers["x-forwarded-for"];

    const realIp =
      req.headers["x-real-ip"];


    if (forwarded) {

      clientIp =
        String(forwarded)
          .split(",")[0]
          .trim();

    } else if (realIp) {

      clientIp =
        String(realIp)
          .trim();
    }

  } catch (error) {

    clientIp =
      "unknown";
  }


  /*
  =======================================================
  EXISTING REFERENCE CHECK
  =======================================================
  */

  try {

    const existingResult =
      await query(
        `
        SELECT
          id,
          reference,
          amount,
          phone,
          status,
          transaction_request_id,
          transaction_id,
          transaction_code

        FROM payments

        WHERE reference = $1

        LIMIT 1
        `,
        [
          cleanReference
        ]
      );


    if (
      existingResult.rows &&
      existingResult.rows.length > 0
    ) {

      const existing =
        existingResult.rows[0];


      /*
      ---------------------------------------------------
      ALREADY COMPLETED
      ---------------------------------------------------
      */

      if (
        String(
          existing.status || ""
        )
          .toLowerCase()
          .includes("complet")
      ) {

        return res.status(200).json({

          success: true,

          paid: true,

          reused: true,

          transaction_id:
            existing.transaction_id ||
            existing.transaction_request_id ||
            existing.transaction_code ||
            null,

          reference:
            existing.reference,

          status:
            "COMPLETED"
        });
      }


      /*
      ---------------------------------------------------
      ALREADY PENDING
      ---------------------------------------------------
      */

      if (
        existing.transaction_id ||
        existing.transaction_request_id
      ) {

        const existingTransaction =
          existing.transaction_id ||
          existing.transaction_request_id;


        return res.status(200).json({

          success: true,

          reused: true,

          transaction_id:
            existingTransaction,

          transaction_request_id:
            existingTransaction,

          reference:
            existing.reference,

          status:
            existing.status ||
            "pending",

          message:
            "An M-PESA payment request is already pending for this payment."
        });
      }
    }

  } catch (error) {

    console.error(
      "EXISTING PAYMENT CHECK ERROR:",
      error
    );
  }


  /*
  =======================================================
  ACTIVE PENDING PAYMENT
  =======================================================
  */

  try {

    const pendingResult =
      await query(
        `
        SELECT
          reference,
          transaction_id,
          transaction_request_id,
          status,
          created_at

        FROM payments

        WHERE phone = $1

        AND LOWER(status) = 'pending'

        AND created_at >
          NOW() - INTERVAL '15 minutes'

        ORDER BY created_at DESC

        LIMIT 1
        `,
        [
          cleanPhone
        ]
      );


    if (
      pendingResult.rows &&
      pendingResult.rows.length > 0
    ) {

      const pending =
        pendingResult.rows[0];

      const transaction =
        pending.transaction_id ||
        pending.transaction_request_id;


      if (transaction) {

        return res.status(429).json({

          success: false,

          blocked: true,

          reason:
            "pending_payment",

          message:
            "An M-PESA payment request is already pending for this number. Please complete it first.",

          transaction_id:
            transaction,

          reference:
            pending.reference
        });
      }
    }

  } catch (error) {

    console.error(
      "PENDING PAYMENT CHECK ERROR:",
      error
    );
  }


  /*
  =======================================================
  60 SECOND PHONE COOLDOWN
  =======================================================
  */

  try {

    const cooldownResult =
      await query(
        `
        SELECT
          created_at

        FROM payment_attempts

        WHERE phone = $1

        AND created_at >
          NOW() - INTERVAL '60 seconds'

        ORDER BY created_at DESC

        LIMIT 1
        `,
        [
          cleanPhone
        ]
      );


    if (
      cooldownResult.rows &&
      cooldownResult.rows.length > 0
    ) {

      const lastAttempt =
        new Date(
          cooldownResult.rows[0].created_at
        );


      const secondsPassed =
        Math.floor(
          (
            Date.now() -
            lastAttempt.getTime()
          ) / 1000
        );


      const waitSeconds =
        Math.max(
          1,
          60 - secondsPassed
        );


      return res.status(429).json({

        success: false,

        blocked: true,

        reason:
          "phone_cooldown",

        retry_after:
          waitSeconds,

        message:
          `Please wait ${waitSeconds} seconds before requesting another M-PESA prompt.`
      });
    }

  } catch (error) {

    console.error(
      "PHONE COOLDOWN CHECK ERROR:",
      error
    );
  }


  /*
  =======================================================
  MAX 3 PHONE ATTEMPTS / 10 MINUTES
  =======================================================
  */

  try {

    const phoneAttemptsResult =
      await query(
        `
        SELECT
          COUNT(*) AS total

        FROM payment_attempts

        WHERE phone = $1

        AND created_at >
          NOW() - INTERVAL '10 minutes'
        `,
        [
          cleanPhone
        ]
      );


    const totalPhoneAttempts =
      Number(
        phoneAttemptsResult.rows[0]?.total || 0
      );


    if (
      totalPhoneAttempts >= 3
    ) {

      return res.status(429).json({

        success: false,

        blocked: true,

        reason:
          "phone_rate_limit",

        message:
          "Too many payment attempts for this number. Please wait and try again later."
      });
    }

  } catch (error) {

    console.error(
      "PHONE RATE LIMIT CHECK ERROR:",
      error
    );
  }


  /*
  =======================================================
  MAX 10 IP ATTEMPTS / 10 MINUTES
  =======================================================
  */

  if (
    clientIp &&
    clientIp !== "unknown"
  ) {

    try {

      const ipAttemptsResult =
        await query(
          `
          SELECT
            COUNT(*) AS total

          FROM payment_attempts

          WHERE ip_address = $1

          AND created_at >
            NOW() - INTERVAL '10 minutes'
          `,
          [
            clientIp
          ]
        );


      const totalIpAttempts =
        Number(
          ipAttemptsResult.rows[0]?.total || 0
        );


      if (
        totalIpAttempts >= 10
      ) {

        return res.status(429).json({

          success: false,

          blocked: true,

          reason:
            "ip_rate_limit",

          message:
            "Too many payment requests from this connection. Please wait and try again."
        });
      }

    } catch (error) {

      console.error(
        "IP RATE LIMIT CHECK ERROR:",
        error
      );
    }
  }


  /*
  =======================================================
  MAX 3 FAILED ATTEMPTS / 10 MINUTES
  =======================================================
  */

  try {

    const failedResult =
      await query(
        `
        SELECT
          COUNT(*) AS total

        FROM payment_attempts

        WHERE phone = $1

        AND status IN (
          'failed',
          'cancelled',
          'canceled',
          'rejected'
        )

        AND created_at >
          NOW() - INTERVAL '10 minutes'
        `,
        [
          cleanPhone
        ]
      );


    const failedAttempts =
      Number(
        failedResult.rows[0]?.total || 0
      );


    if (
      failedAttempts >= 3
    ) {

      return res.status(429).json({

        success: false,

        blocked: true,

        reason:
          "failed_attempt_limit",

        message:
          "Too many failed or cancelled payment attempts. Please wait before trying again."
      });
    }

  } catch (error) {

    console.error(
      "FAILED ATTEMPT CHECK ERROR:",
      error
    );
  }


  /*
  =======================================================
  RECORD PAYMENT ATTEMPT
  =======================================================
  */

  let attemptId =
    null;


  try {

    const attemptResult =
      await query(
        `
        INSERT INTO payment_attempts
        (
          phone,
          ip_address,
          reference,
          amount,
          status,
          created_at,
          updated_at
        )

        VALUES
        (
          $1,
          $2,
          $3,
          $4,
          'pending',
          NOW(),
          NOW()
        )

        RETURNING id
        `,
        [
          cleanPhone,
          clientIp,
          cleanReference,
          paymentAmount
        ]
      );


    attemptId =
      attemptResult.rows[0]?.id ||
      null;


    if (!attemptId) {

      return res.status(500).json({
        success: false,
        message:
          "Unable to record payment attempt"
      });
    }

  } catch (error) {

    console.error(
      "SAVE PAYMENT ATTEMPT ERROR:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Payment protection is temporarily unavailable"
    });
  }


  /*
  =======================================================
  PAYLOR CALLBACK URL
  =======================================================
  */

  const callbackUrl =
    `${
      process.env.VERCEL_URL
        ? "https://" +
          process.env.VERCEL_URL
        : ""
    }/api/payment-callback`;


  /*
  =======================================================
  IDEMPOTENCY KEY
  =======================================================
  */

  const idempotencyKey =
    crypto
      .createHash("sha256")
      .update(
        `${cleanReference}:${cleanPhone}:${paymentAmount}`
      )
      .digest("hex");


  /*
  =======================================================
  SAVE PENDING PAYMENT
  =======================================================
  */

  try {

    await query(
      `
      INSERT INTO payments
      (
        reference,
        amount,
        phone,
        status,
        created_at,
        updated_at
      )

      VALUES
      (
        $1,
        $2,
        $3,
        'pending',
        NOW(),
        NOW()
      )

      ON CONFLICT(reference)

      DO UPDATE SET
        amount = EXCLUDED.amount,
        phone = EXCLUDED.phone,
        updated_at = NOW()
      `,
      [
        cleanReference,
        paymentAmount,
        cleanPhone
      ]
    );

  } catch (error) {

    console.error(
      "SAVE PENDING PAYMENT ERROR:",
      error
    );


    try {

      await query(
        `
        UPDATE payment_attempts

        SET
          status = 'failed',
          updated_at = NOW()

        WHERE id = $1
        `,
        [
          attemptId
        ]
      );

    } catch (updateError) {

      console.error(
        "ATTEMPT UPDATE ERROR:",
        updateError
      );
    }


    return res.status(500).json({
      success: false,
      message:
        "Unable to create payment record"
    });
  }


  /*
  =======================================================
  PART 2 CONTINUES DIRECTLY BELOW
  =======================================================
  */
    /*
  =======================================================
  PAYLOR STK PUSH
  =======================================================
  */

  try {

    const paylorResponse =
      await fetch(
        "https://api.paylorke.com/api/v1/merchants/payments/stk-push",
        {

          method: "POST",

          headers: {

            "Authorization":
              `Bearer ${apiKey}`,

            "Content-Type":
              "application/json",

            "Idempotency-Key":
              idempotencyKey
          },

          body:
            JSON.stringify({

              phone:
                cleanPhone,

              amount:
                paymentAmount,

              reference:
                cleanReference,

              channelId:
                channelId,

              description:
                "Payment for Live Service",

              callbackUrl:
                callbackUrl
            })
        }
      );


    const responseText =
      await paylorResponse.text();


    let data =
      {};

    try {

      data =
        JSON.parse(
          responseText
        );

    } catch (error) {

      data =
        {};
    }


    /*
    =====================================================
    PAYLOR ERROR
    =====================================================
    */

    if (!paylorResponse.ok) {

      console.error(
        "PAYLOR STK ERROR:",
        paylorResponse.status,
        data
      );


      await query(
        `
        UPDATE payments

        SET
          status = 'failed',
          updated_at = NOW()

        WHERE reference = $1
        `,
        [
          cleanReference
        ]
      );


      await query(
        `
        UPDATE payment_attempts

        SET
          status = 'failed',
          updated_at = NOW()

        WHERE id = $1
        `,
        [
          attemptId
        ]
      );


      return res.status(
        paylorResponse.status || 502
      ).json({

        success: false,

        message:
          data.message ||
          data.error ||
          "Paylor could not send the M-PESA prompt",

        provider_status:
          paylorResponse.status
      });
    }


    /*
    =====================================================
    TRANSACTION ID
    =====================================================
    */

    const transactionId =
      data.transactionId ||
      data.transaction_id ||
      data.transactionRequestId ||
      data.transaction_request_id ||
      data.paymentId ||
      null;


    if (!transactionId) {

      console.error(
        "PAYLOR RESPONSE WITHOUT TRANSACTION ID:",
        data
      );


      await query(
        `
        UPDATE payments

        SET
          status = 'failed',
          updated_at = NOW()

        WHERE reference = $1
        `,
        [
          cleanReference
        ]
      );


      await query(
        `
        UPDATE payment_attempts

        SET
          status = 'failed',
          updated_at = NOW()

        WHERE id = $1
        `,
        [
          attemptId
        ]
      );


      return res.status(502).json({

        success: false,

        message:
          "Paylor did not return a transaction ID"
      });
    }


    /*
    =====================================================
    SAVE TRANSACTION ID
    =====================================================
    */

    try {

      await query(
        `
        UPDATE payments

        SET
          transaction_request_id = $1,
          transaction_id = $1,
          status = 'pending',
          updated_at = NOW()

        WHERE reference = $2
        `,
        [
          String(transactionId),
          cleanReference
        ]
      );

    } catch (error) {

      console.error(
        "SAVE TRANSACTION ERROR:",
        error
      );
    }


    /*
    =====================================================
    UPDATE PAYMENT ATTEMPT
    =====================================================
    */

    try {

      await query(
        `
        UPDATE payment_attempts

        SET
          status = 'pending',
          transaction_id = $1,
          updated_at = NOW()

        WHERE id = $2
        `,
        [
          String(transactionId),
          attemptId
        ]
      );

    } catch (error) {

      console.error(
        "ATTEMPT TRANSACTION UPDATE ERROR:",
        error
      );
    }


    /*
    =====================================================
    SUCCESS
    =====================================================
    */

    return res.status(200).json({

      success: true,

      transaction_id:
        String(transactionId),

      transaction_request_id:
        String(transactionId),

      reference:
        cleanReference,

      status:
        data.status ||
        "SENT",

      message:
        "M-PESA prompt sent successfully"
    });


  } catch (error) {

    console.error(
      "PAYLOR REQUEST ERROR:",
      error
    );


    /*
    -----------------------------------------------------
    MARK ATTEMPT FAILED
    -----------------------------------------------------
    */

    try {

      await query(
        `
        UPDATE payment_attempts

        SET
          status = 'failed',
          updated_at = NOW()

        WHERE id = $1
        `,
        [
          attemptId
        ]
      );

    } catch (dbError) {

      console.error(
        "ATTEMPT FAILURE UPDATE ERROR:",
        dbError
      );
    }


    /*
    -----------------------------------------------------
    MARK PAYMENT FAILED
    -----------------------------------------------------
    */

    try {

      await query(
        `
        UPDATE payments

        SET
          status = 'failed',
          updated_at = NOW()

        WHERE reference = $1
        `,
        [
          cleanReference
        ]
      );

    } catch (dbError) {

      console.error(
        "PAYMENT FAILURE UPDATE ERROR:",
        dbError
      );
    }


    return res.status(502).json({

      success: false,

      message:
        "Unable to connect to Paylor. Please try again."
    });
  }
};
