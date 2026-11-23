
const { clearSessionCookie } = require("../auth-utils");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return res.status(405).json({
      success: false,
      message: "Method not allowed."
    });
  }

  try {
    clearSessionCookie(res);

    return res.status(200).json({
      success: true,
      message: "You have logged out successfully."
    });

  } catch (error) {
    console.error("Logout error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to log out. Please try again."
    });
  }
};
