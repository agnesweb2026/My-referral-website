const {
  query,
  ensurePaymentTable,
  pool
} = require("./db");


const COMMISSION_RATE = 0.25;


const EMPLOYEE_MAP = {

  joshua1: {
    id: "REF-A7K2",
    referral: "REF-A7K2",
    username: "Joshua1"
  },

  joshua2: {
    id: "REF-B4M8",
    referral: "REF-B4M8",
    username: "Joshua2"
  },

  joshua3: {
    id: "REF-C9P3",
    referral: "REF-C9P3",
    username: "Joshua3"
  },

  joshua4: {
    id: "REF-D2X6",
    referral: "REF-D2X6",
    username: "Joshua4"
  },

  joshua5: {
    id: "REF-E5Q1",
    referral: "REF-E5Q1",
    username: "Joshua5"
  },

  joshua6: {
    id: "REF-F8L4",
    referral: "REF-F8L4",
    username: "Joshua6"
  },

  joshua7: {
    id: "REF-G3N7",
    referral: "REF-G3N7",
    username: "Joshua7"
  },

  joshua8: {
    id: "REF-H6R2",
    referral: "REF-H6R2",
    username: "Joshua8"
  },

  joshua9: {
    id: "REF-J9T5",
    referral: "REF-J9T5",
    username: "Joshua9"
  },

  joshua10: {
    id: "REF-K4W8",
    referral: "REF-K4W8",
    username: "Joshua10"
  }
};


function resolveEmployee(value) {

  const raw =
    String(value || "")
      .trim()
      .toLowerCase();


  if (!raw) {
    return null;
  }


  if (EMPLOYEE_MAP[raw]) {
    return EMPLOYEE_MAP[raw];
  }


  for (
    const key of Object.keys(EMPLOYEE_MAP)
  ) {

    const employee =
      EMPLOYEE_MAP[key];


    if (
      employee.id.toLowerCase() === raw ||
      employee.referral.toLowerCase() === raw
    ) {

      return employee;
    }
  }


  return null;
}


function resolveEmployeeFromReference(
  reference
) {

  const ref =
    String(reference || "")
      .toUpperCase();


  for (
    const key of Object.keys(EMPLOYEE_MAP)
  ) {

    const employee =
      EMPLOYEE_MAP[key];


    const id =
      employee.id.toUpperCase();

    const referral =
      employee.referral.toUpperCase();


    const cleanId =
      id.replace(
        /[^A-Z0-9]/g,
        ""
      );

    const cleanReferral =
      referral.replace(
        /[^A-Z0-9]/g,
        ""
      );


    if (
      ref.includes(cleanId) ||
      ref.includes(cleanReferral) ||
      ref.includes(
        key.toUpperCase()
      )
    ) {

      return employee;
    }
  }


  return null;
}


async function ensureCommissionTable() {

  await pool.query(`
    CREATE TABLE IF NOT EXISTS employee_commissions (

      id BIGSERIAL PRIMARY KEY,

      transaction_id VARCHAR(150)
        UNIQUE NOT NULL,

      reference VARCHAR(100),

      employee_id VARCHAR(100)
        NOT NULL,

      username VARCHAR(100),

      referral VARCHAR(100)
        NOT NULL,

      payment_amount NUMERIC(12,2)
        NOT NULL,

      commission_rate NUMERIC(5,4)
        NOT NULL DEFAULT 0.40,

      commission_amount NUMERIC(12,2)
        NOT NULL,

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()

    );
  `);
}


module.exports = async function handler(
  req,
  res
) {

  if (req.method !== "POST") {

    return res.status(405).json({
      success: false,
      message:
        "Method not allowed"
    });
  }


  try {

    await ensurePaymentTable();

    await ensureCommissionTable();


    const body =
      req.body || {};


    const transactionId =
      String(
        body.transaction_id ||
        body.transactionId ||
        body.transaction_request_id ||
        ""
      ).trim();


    const reference =
      String(
        body.reference ||
        ""
      ).trim();


    const employeeValue =
      String(
        body.employeeId ||
        body.employee ||
        body.username ||
        body.referral ||
        ""
      ).trim();


    if (!transactionId) {

      return res.status(400).json({

        success: false,

        paid: false,

        message:
          "Transaction ID is required"
      });
    }


    /*
    =====================================================
    EMPLOYEE
    =====================================================
    */

    let employee =
      resolveEmployee(
        employeeValue
      );


    if (
      !employee &&
      reference
    ) {

      employee =
        resolveEmployeeFromReference(
          reference
        );
    }


    /*
    =====================================================
    LOCAL PAYMENT
    =====================================================
    */

    const localResult =
      await query(
        `
        SELECT
          reference,
          amount,
          phone,
          status,
          transaction_request_id,
          transaction_id,
          transaction_code

        FROM payments

        WHERE
          transaction_id = $1
          OR transaction_request_id = $1
          OR reference = $2

        ORDER BY updated_at DESC

        LIMIT 1
        `,
        [
          transactionId,
          reference || null
        ]
      );


    const payment =
      localResult.rows[0] ||
      null;


    /*
    =====================================================
    PAYLOR STATUS
    =====================================================
    */

    const API_KEY =
      process.env.PAYLOR_API_KEY;


    if (!API_KEY) {

      return res.status(500).json({

        success: false,

        paid: false,

        message:
          "Paylor API key is not configured on the server"
      });
    }


    const paylorResponse =
      await fetch(

        "https://api.paylorke.com/api/v1/merchants/payments/transactions/" +
        encodeURIComponent(
          transactionId
        ),

        {
          method: "GET",

          headers: {

            "Authorization":
              `Bearer ${API_KEY}`,

            "Content-Type":
              "application/json",

            "Accept":
              "application/json"
          }
        }
      );


    const rawText =
      await paylorResponse.text();


    let paylorData;


    try {

      paylorData =
        JSON.parse(
          rawText
        );

    } catch {

      paylorData = {
        message:
          rawText
      };
    }


    /*
    =====================================================
    PAYLOR TEMPORARY ERROR
    =====================================================
    */

    if (!paylorResponse.ok) {

      console.error(
        "PAYLOR STATUS ERROR:",
        paylorResponse.status,
        paylorData
      );


      return res.status(200).json({

        success: true,

        paid: false,

        status:
          "PENDING",

        message:
          "Payment is still being verified"
      });
    }


    const paylorTransaction =
      paylorData.transaction ||
      paylorData.data ||
      paylorData;


    const paylorStatus =
      String(
        paylorTransaction.status ||
        paylorData.status ||
        ""
      )
        .toUpperCase()
        .trim();


    const paylorReference =
      paylorTransaction.reference ||
      paylorData.reference ||
      reference ||
      "";


    const paylorAmount =
      Number(
        paylorTransaction.amount ||
        paylorData.amount ||
        (payment &&
          payment.amount) ||
        0
      );


    /*
    =====================================================
    FAILED / CANCELLED
    =====================================================
    */

    if (
      paylorStatus === "FAILED" ||
      paylorStatus === "CANCELLED" ||
      paylorStatus === "CANCELED" ||
      paylorStatus === "REJECTED"
    ) {

      /*
      UPDATE PAYMENT
      */

      await query(
        `
        UPDATE payments

        SET
          status = 'failed',
          updated_at = NOW()

        WHERE
          transaction_id = $1
          OR transaction_request_id = $1
        `,
        [
          transactionId
        ]
      );


      /*
      UPDATE PAYMENT ATTEMPT
      */

      await query(
        `
        UPDATE payment_attempts

        SET
          status = $1,
          transaction_id = $2,
          updated_at = NOW()

        WHERE
          transaction_id = $2

          OR reference = $3
        `,
        [
          paylorStatus === "CANCELLED" ||
          paylorStatus === "CANCELED"
            ? "cancelled"
            : paylorStatus.toLowerCase(),

          transactionId,

          paylorReference
        ]
      );


      return res.status(200).json({

        success: true,

        paid: false,

        status:
          paylorStatus,

        message:
          "M-PESA payment was not completed"
      });
    }


    /*
    =====================================================
    STILL PENDING
    =====================================================
    */

    if (
      paylorStatus !== "COMPLETED"
    ) {

      return res.status(200).json({

        success: true,

        paid: false,

        status:
          paylorStatus ||
          "PENDING",

        message:
          "Waiting for M-PESA payment"
      });
    }


    /*
    =====================================================
    PAYMENT COMPLETED
    =====================================================
    */

    const finalReference =
      paylorReference ||
      (
        payment &&
        payment.reference
      ) ||
      reference;


    const finalAmount =
      paylorAmount ||
      Number(
        payment &&
        payment.amount
      );


    /*
    =====================================================
    SERVER-SIDE AMOUNT CHECK
    =====================================================
    */

    const ALLOWED_AMOUNTS = [
      80,
      100,
      150,
      200,
      250,
      300
    ];


    if (
      !ALLOWED_AMOUNTS.includes(
        Math.round(
          finalAmount
        )
      )
    ) {

      console.error(
        "INVALID COMPLETED PAYMENT AMOUNT:",
        finalAmount,
        transactionId
      );


      return res.status(400).json({

        success: false,

        paid: false,

        message:
          "Invalid confirmed payment amount"
      });
    }


    /*
    =====================================================
    UPDATE PAYMENT
    =====================================================
    */

    await query(
      `
      UPDATE payments

      SET
        status = 'completed',

        transaction_id = $1,

        transaction_request_id =
          COALESCE(
            transaction_request_id,
            $1
          ),

        updated_at = NOW()

      WHERE
        reference = $2
        OR transaction_id = $1
        OR transaction_request_id = $1
      `,
      [
        transactionId,
        finalReference
      ]
    );


    /*
    =====================================================
    MARK PAYMENT ATTEMPT COMPLETED
    =====================================================
    */

    await query(
      `
      UPDATE payment_attempts

      SET
        status = 'completed',
        transaction_id = $1,
        updated_at = NOW()

      WHERE
        transaction_id = $1
        OR reference = $2
      `,
      [
        transactionId,
        finalReference
      ]
    );


    /*
    =====================================================
    25% COMMISSION
    =====================================================
    */

    if (employee) {

      const commission =
        Number(
          (
            finalAmount *
            COMMISSION_RATE
          ).toFixed(2)
        );


      await pool.query(
        `
        INSERT INTO employee_commissions
        (
          transaction_id,
          reference,
          employee_id,
          username,
          referral,
          payment_amount,
          commission_rate,
          commission_amount
        )

        VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8
        )

        ON CONFLICT (
          transaction_id
        )

        DO NOTHING
        `,
        [
          transactionId,

          finalReference ||
            null,

          employee.id,

          employee.username,

          employee.referral,

          finalAmount,

          COMMISSION_RATE,

          commission
        ]
      );


      console.log(
        "25% COMMISSION RECORDED:",
        employee.username,
        commission,
        transactionId
      );

    } else {

      console.log(
        "PAYMENT COMPLETED BUT NO EMPLOYEE REFERRAL:",
        finalReference,
        transactionId
      );
    }


    /*
    =====================================================
    FINAL SUCCESS
    =====================================================
    */

    return res.status(200).json({

      success: true,

      paid: true,

      status:
        "COMPLETED",

      transaction_id:
        transactionId,

      reference:
        finalReference,

      amount:
        finalAmount,

      employee:
        employee
          ? employee.username
          : null
    });


  } catch (error) {

    console.error(
      "PAYMENT STATUS ERROR:",
      error
    );


    return res.status(200).json({

      success: true,

      paid: false,

      status:
        "PENDING",

      message:
        "Payment is still being verified"
    });
  }
};
