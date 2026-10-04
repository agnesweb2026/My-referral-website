const { pool } = require("./employee-db");

function sendJson(res, status, data) {
  return res.status(status).json(data);
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return sendJson(res, 405, {
      success: false,
      error: "Method not allowed"
    });
  }

  try {
    const employeeId = String(
      req.query.employeeId || ""
    ).trim();

    const referral = String(
      req.query.referral || ""
    ).trim();

    if (!employeeId && !referral) {
      return sendJson(res, 400, {
        success: false,
        error: "Missing employeeId or referral"
      });
    }

    let result;

    if (employeeId) {
      result = await pool.query(
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
        WHERE employee_id = $1
        ORDER BY created_at DESC
        `,
        [employeeId]
      );
    } else {
      result = await pool.query(
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
        WHERE referral = $1
        ORDER BY created_at DESC
        `,
        [referral]
      );
    }

    const records = result.rows.map(function(row) {
      return {
        id: row.id,
        transaction_id: row.transaction_id,
        reference: row.reference,
        employeeId: row.employee_id,
        username: row.username,
        referral: row.referral,
        paymentAmount: Number(row.payment_amount),
        commissionRate: Number(row.commission_rate),
        commission: Number(row.commission_amount),
        createdAt: row.created_at
      };
    });

    const totalCommission = Math.round(
      records.reduce(function(total, item) {
        return total + Number(item.commission || 0);
      }, 0) * 100
    ) / 100;

    return sendJson(res, 200, {
      success: true,
      commissionRate: 0.40,
      totalCommission,
      records
    });

  } catch (error) {
    console.error(
      "Employee commission list error:",
      error
    );

    return sendJson(res, 500, {
      success: false,
      error: "Failed to load employee commissions"
    });
  }
};
