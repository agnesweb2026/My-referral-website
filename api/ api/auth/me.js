
const {
  getSessionToken,
  verifySession,
  clearSessionCookie
} = require("../auth-utils");

const db = require("../db");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");

    return res.status(405).json({
      success: false,
      message: "Method not allowed."
    });
  }

  try {
    const token = getSessionToken(req);

    if (!token) {
      return res.status(401).json({
        success: false,
        authenticated: false
      });
    }

    const session = verifySession(token);

    if (!session || !session.userId) {
      clearSessionCookie(res);

      return res.status(401).json({
        success: false,
        authenticated: false
      });
    }

    const result = await db.query(
      `SELECT id, phone
       FROM website_users
       WHERE id = $1
       LIMIT 1`,
      [session.userId]
    );

    if (result.rows.length === 0) {
      clearSessionCookie(res);

      return res.status(401).json({
        success: false,
        authenticated: false
      });
    }

    return res.status(200).json({
      success: true,
      authenticated: true,
      user: {
        id: result.rows[0].id,
        phone: result.rows[0].phone
      }
    });

  } catch (error) {
    console.error("Session check error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to check login status."
    });
  }
};
