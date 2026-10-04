const { pool } = require("./db");

const COMMISSION_RATE = 0.40;


/*
==================================================
EMPLOYEE MAPPING
==================================================
*/

const EMPLOYEE_MAP = {
  "joshua1": "REF-A7K2",
  "joshua2": "REF-B4M8",
  "joshua3": "REF-C9P3",
  "joshua4": "REF-D2X6",
  "joshua5": "REF-E5Q1",
  "joshua6": "REF-F8L4",
  "joshua7": "REF-G3N7",
  "joshua8": "REF-H6R2",
  "joshua9": "REF-J9T5",
  "joshua10": "REF-K4W8"
};


/*
==================================================
CREATE TABLE
==================================================
*/

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


/*
==================================================
RESOLVE EMPLOYEE ID
==================================================
*/

function resolveEmployeeId(value) {

  const raw =
    String(value || "").trim();

  if (!raw) {
    return "";
  }


  /*
  Joshua1 -> REF-A7K2
  */

  const mapped =
    EMPLOYEE_MAP[
      raw.toLowerCase()
    ];

  if (mapped) {
    return mapped;
  }


  /*
  Already REF-XXXX
  */

  return raw;

}


/*
==================================================
MAIN API
==================================================
*/

module.exports = async function handler(
  req,
  res
) {

  if (req.method !== "GET") {

    return res.status(405).json({

      success: false,

      error:
        "Method not allowed"

    });

  }


  try {

    await ensureCommissionTable();


    const requestedEmployee =
      String(
        req.query.employeeId || ""
      ).trim();


    if (!requestedEmployee) {

      return res.status(400).json({

        success: false,

        error:
          "Employee ID is required",

        records: [],

        totalCommission: 0

      });

    }


    const employeeId =
      resolveEmployeeId(
        requestedEmployee
      );


    /*
    ==============================================
    LOAD COMMISSIONS
    ==============================================
    */

    const result =
      await pool.query(
        `
        SELECT

          id,

          transaction_id,

          reference,

          employee_id,

          username,

          referral,

          payment_amount,

          commission_rate,

          commission_amount,

          created_at

        FROM employee_commissions

        WHERE

          LOWER(employee_id) =
          LOWER($1)

          OR LOWER(referral) =
          LOWER($1)

          OR LOWER(username) =
          LOWER($2)

        ORDER BY
          created_at DESC
        `,
        [
          employeeId,
          requestedEmployee
        ]
      );


    /*
    ==============================================
    TOTAL
    ==============================================
    */

    const totalCommission =
      result.rows.reduce(
        function(
          total,
          row
        ) {

          return (
            total +
            Number(
              row.commission_amount ||
              0
            )
          );

        },
        0
      );


    /*
    ==============================================
    FORMAT RECORDS
    ==============================================
    */

    const records =
      result.rows.map(
        function(row) {

          return {

            id:
              row.id,

            transactionId:
              row.transaction_id,

            transaction_id:
              row.transaction_id,

            reference:
              row.reference,

            employeeId:
              row.employee_id,

            username:
              row.username,

            referral:
              row.referral,

            paymentAmount:
              Number(
                row.payment_amount ||
                0
              ),

            commissionRate:
              Number(
                row.commission_rate ||
                COMMISSION_RATE
              ),

            commission:
              Number(
                row.commission_amount ||
                0
              ),

            createdAt:
              row.created_at

          };

        }
      );


    /*
    ==============================================
    RETURN
    ==============================================
    */

    return res.status(200).json({

      success: true,

      employeeId,

      commissionRate:
        COMMISSION_RATE,

      totalCommission:
        Number(
          totalCommission.toFixed(2)
        ),

      records

    });


  } catch (error) {

    console.error(
      "Employee commission list error:",
      error
    );


    return res.status(500).json({

      success: false,

      error:
        "Unable to load employee commissions",

      records: [],

      totalCommission: 0

    });

  }

};
