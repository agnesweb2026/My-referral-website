const crypto = require("crypto");
const {
  query,
  ensurePaymentTable
} = require("./db");


/*
=========================================================
PAYLOR STK PUSH
=========================================================

SUPPORTED NUMBERS:

01XXXXXXXX
07XXXXXXXX

2541XXXXXXXX
2547XXXXXXXX

ALSO ACCEPTS:

1XXXXXXXX
7XXXXXXXX

=========================================================
*/


module.exports = async function handler(req, res) {

  /*
  =======================================================
  METHOD
  =======================================================
  */

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


  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {

    return res.status(400).json({
      success: false,
      message:
        "A valid payment amount is required"
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
  REFERENCE LENGTH PROTECTION
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

  01XXXXXXXX
       ↓
  2541XXXXXXXX

  07XXXXXXXX
       ↓
  2547XXXXXXXX

  1XXXXXXXX
       ↓
  2541XXXXXXXX

  7XXXXXXXX
       ↓
  2547XXXXXXXX

  =======================================================
  */

  let cleanPhone =
    String(phone)
      .replace(/\D/g, "")
      .trim();


  /*
  -------------------------------------------------------
  01XXXXXXXX / 07XXXXXXXX
  -------------------------------------------------------
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
  -------------------------------------------------------
  1XXXXXXXX / 7XXXXXXXX
  -------------------------------------------------------
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

  ACCEPT ONLY:

  2541XXXXXXXX
  2547XXXXXXXX

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
  AMOUNT
  =======================================================
  */

  const paymentAmount =
    Math.round(amount);


  /*
  =======================================================
  EXISTING PAYMENT PROTECTION
  =======================================================

  If the same reference already exists:

  COMPLETED
      → do not charge again

  PENDING
      → return the existing transaction

  This helps prevent duplicate STK prompts.
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
        [cleanReference]
      );


    if (
      existingResult.rows &&
      existingResult.rows.length > 0
    ) {

      const existing =
        existingResult.rows[0];


      /*
      ---------------------------------------------------
      ALREADY PAID
      ---------------------------------------------------
      */

      if (
        String(existing.status || "")
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
      EXISTING PENDING TRANSACTION
      ---------------------------------------------------

      Do not create another prompt.
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
            existing.status || "pending",

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
  PAYLOR CALLBACK URL
  =======================================================
  */

  const callbackUrl =
    `${
      process.env.VERCEL_URL
        ? "https://" + process.env.VERCEL_URL
        : ""
    }/api/payment-callback`;


  /*
  =======================================================
  IDEMPOTENCY KEY
  =======================================================

  Same reference + same phone + same amount
  produces the same key.

  This protects against duplicate requests.
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

    return res.status(500).json({
      success: false,
      message:
        "Unable to create payment record"
    });

  }


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


    /*
    =====================================================
    PAYLOR RESPONSE
    =====================================================
    */

    const responseText =
      await paylorResponse.text();


    let data = {};

    try {

      data =
        JSON.parse(
          responseText
        );

    } catch (error) {

      data = {};

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


      /*
      -----------------------------------------------
      MARK PAYMENT FAILED
      -----------------------------------------------
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
          [cleanReference]
        );

      } catch (dbError) {

        console.error(
          "FAILED PAYMENT UPDATE ERROR:",
          dbError
        );

      }


      /*
      -----------------------------------------------
      PAYLOR ERROR RESPONSE
      -----------------------------------------------
      */

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


    /*
    =====================================================
    NO TRANSACTION ID
    =====================================================
    */

    if (!transactionId) {

      console.error(
        "PAYLOR RESPONSE WITHOUT TRANSACTION ID:",
        data
      );


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
          "PAYMENT UPDATE ERROR:",
          dbError
        );

      }


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

      /*
      IMPORTANT:
      The prompt may already have been sent,
      so do not automatically send another prompt.
      */

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
        data.status || "SENT",

      message:
        "M-PESA prompt sent successfully"

    });


  } catch (error) {

    console.error(
      "PAYLOR REQUEST ERROR:",
      error
    );


    /*
    =====================================================
    IMPORTANT:
    DO NOT AUTOMATICALLY RETRY STK PUSH
    =====================================================

    This prevents accidental duplicate prompts.
    =====================================================
    */

    return res.status(502).json({

      success: false,

      message:
        "Unable to connect to Paylor. Please try again."

    });

  }

};
