const { pool } = require("./db");

const COMMISSION_RATE = 0.30;

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
        NOT NULL DEFAULT 0.30,

      commission_amount NUMERIC(12,2)
        NOT NULL,

      created_at TIMESTAMPTZ
        NOT NULL DEFAULT NOW()

    );
  `);

}


function resolveEmployee(value) {

  const raw =
    String(value || "").trim();

  if (!raw) {
    return null;
  }

  const lower =
    raw.toLowerCase();


  if (EMPLOYEE_MAP[lower]) {

    return EMPLOYEE_MAP[lower];

  }


  for (
    const key of Object.keys(EMPLOYEE_MAP)
  ) {

    const employee =
      EMPLOYEE_MAP[key];

    if (
      employee.id.toLowerCase() ===
      lower
    ) {

      return employee;

    }

    if (
      employee.referral.toLowerCase() ===
      lower
    ) {

      return employee;

    }

  }


  return null;
}


module.exports =
async function handler(req, res) {

  if (req.method !== "POST") {

    return res.status(405).json({

      success: false,

      error:
        "Method not allowed"

    });

  }


  try {

    await ensureCommissionTable();


    const body =
      req.body || {};


    const employeeValue =
      String(

        body.employeeId ||
        body.employee ||
        body.username ||
        body.referral ||
        ""

      ).trim();


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


    if (!employeeValue) {

      return res.status(400).json({

        success: false,

        error:
          "Employee ID is required"

      });

    }


    if (!transactionId) {

      return res.status(400).json({

        success: false,

        error:
          "Transaction ID is required"

      });

    }


    const employee =
      resolveEmployee(
        employeeValue
      );


    if (!employee) {

      return res.status(400).json({

        success: false,

        error:
          "Unknown employee"

      });

    }


    /*
    =====================================================
    FIND CONFIRMED PAYMENT
    =====================================================
    */

    const paymentResult =
      await pool.query(
        `
        SELECT

          reference,

          amount,

          status,

          transaction_request_id,

          transaction_id,

          transaction_code

        FROM payments

        WHERE

          transaction_id = $1

          OR transaction_request_id = $1

          OR transaction_code = $1

          OR reference = $2

        ORDER BY updated_at DESC

        LIMIT 1
        `,
        [
          transactionId,
          reference
        ]
      );


    if (
      paymentResult.rows.length === 0
    ) {

      return res.status(400).json({

        success: false,

        error:
          "Payment not found"

      });

    }


    const payment =
      paymentResult.rows[0];


    const paymentStatus =
      String(
        payment.status || ""
      )
      .toLowerCase()
      .trim();


    const completed =
      paymentStatus === "completed" ||
      paymentStatus === "complete" ||
      paymentStatus === "paid" ||
      paymentStatus === "success" ||
      paymentStatus === "successful";


    if (!completed) {

      return res.status(400).json({

        success: false,

        error:
          "Payment is not completed"

      });

    }


    const amount =
      Number(
        payment.amount
      );


    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {

      return res.status(400).json({

        success: false,

        error:
          "Invalid confirmed payment amount"

      });

    }


    /*
    =====================================================
    30% COMMISSION
    =====================================================
    */

    const commission =
      Number(
        (
          amount *
          COMMISSION_RATE
        ).toFixed(2)
      );


    /*
    =====================================================
    INSERT ONCE
    =====================================================
    */

    const insert =
      await pool.query(
        `
        INSERT INTO employee_commissions (

          transaction_id,

          reference,

          employee_id,

          username,

          referral,

          payment_amount,

          commission_rate,

          commission_amount

        )

        VALUES (

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

        RETURNING *

        `,
        [

          transactionId,

          payment.reference ||
            reference ||
            null,

          employee.id,

          employee.username,

          employee.referral,

          amount,

          COMMISSION_RATE,

          commission

        ]
      );


    /*
    =====================================================
    ALREADY EXISTS
    =====================================================
    */

    if (
      insert.rows.length === 0
    ) {

      const existing =
        await pool.query(
          `
          SELECT
            commission_amount
          FROM employee_commissions
          WHERE transaction_id = $1
          LIMIT 1
          `,
          [transactionId]
        );


      return res.status(200).json({

        success: true,

        alreadyRecorded: true,

        employeeId:
          employee.id,

        username:
          employee.username,

        commission:
          existing.rows.length
            ? Number(
                existing.rows[0]
                  .commission_amount || 0
              )
            : commission,

        commissionRate:
          COMMISSION_RATE

      });

    }


    /*
    =====================================================
    SUCCESS
    =====================================================
    */

    return res.status(200).json({

      success: true,

      alreadyRecorded: false,

      employeeId:
        employee.id,

      username:
        employee.username,

      referral:
        employee.referral,

      paymentAmount:
        amount,

      commissionRate:
        COMMISSION_RATE,

      commission

    });


  } catch (error) {

    console.error(
      "EMPLOYEE COMMISSION ERROR:",
      error
    );


    return res.status(500).json({

      success: false,

      error:
        "Unable to record employee commission"

    });

  }

};
