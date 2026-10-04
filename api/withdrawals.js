import { put, get } from "@vercel/blob";

const FILE_NAME = "withdrawal-requests.json";

async function readRequests() {
  try {
    const result = await get(FILE_NAME, {
      access: "private",
      useCache: false
    });

    if (!result || !result.stream) {
      return [];
    }

    const text = await new Response(result.stream).text();

    if (!text) {
      return [];
    }

    const data = JSON.parse(text);

    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error("Read withdrawals error:", error);
    return [];
  }
}

async function saveRequests(requests) {
  await put(
    FILE_NAME,
    JSON.stringify(requests, null, 2),
    {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json"
    }
  );
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function validPhone(phone) {
  return /^07\d{8}$/.test(cleanText(phone));
}

function validAmount(amount) {
  const value = Number(amount);
  return Number.isFinite(value) && value > 0;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    // =========================
    // GET WITHDRAWAL REQUESTS
    // =========================
    if (req.method === "GET") {
      const requests = await readRequests();

      return res.status(200).json({
        success: true,
        requests
      });
    }

    // =========================
    // CREATE WITHDRAWAL
    // =========================
    if (req.method === "POST") {
      const body =
        typeof req.body === "string"
          ? JSON.parse(req.body)
          : req.body || {};

      const employeeName = cleanText(body.employeeName);
      const employeeId = cleanText(body.employeeId);
      const username = cleanText(body.username);
      const referral = cleanText(body.referral);
      const phone = cleanText(body.phone);
      const amount = Number(body.amount);

      if (
        !employeeName ||
        !employeeId ||
        !username ||
        !referral ||
        !phone ||
        !body.amount
      ) {
        return res.status(400).json({
          success: false,
          message: "Missing withdrawal information."
        });
      }

      if (!validAmount(amount)) {
        return res.status(400).json({
          success: false,
          message: "Invalid withdrawal amount."
        });
      }

      if (!validPhone(phone)) {
        return res.status(400).json({
          success: false,
          message: "Invalid Kenyan phone number."
        });
      }

      const requests = await readRequests();

      // Only ONE pending request per employee
      const pending = requests.some(function (request) {
        const sameEmployee =
          String(request.employeeId || "") ===
          String(employeeId);

        const status =
          String(request.status || "").toUpperCase();

        return sameEmployee && status === "PENDING";
      });

      if (pending) {
        return res.status(409).json({
          success: false,
          message:
            "You already have a pending withdrawal request."
        });
      }

      const newRequest = {
        id:
          "WD-" +
          Date.now() +
          "-" +
          Math.random().toString(36).slice(2, 8),

        employeeName,
        employeeId,
        username,
        referral,
        amount,
        phone,

        status: "PENDING",

        createdAt: new Date().toISOString()
      };

      requests.push(newRequest);

      await saveRequests(requests);

      return res.status(201).json({
        success: true,
        request: newRequest
      });
    }

    // =========================
    // ADMIN APPROVE / REJECT
    // =========================
    if (req.method === "PUT") {
      const body =
        typeof req.body === "string"
          ? JSON.parse(req.body)
          : req.body || {};

      const id = cleanText(body.id);

      const requestedStatus =
        cleanText(body.status).toUpperCase();

      if (!id || !requestedStatus) {
        return res.status(400).json({
          success: false,
          message:
            "Request ID and status are required."
        });
      }

      if (
        requestedStatus !== "APPROVED" &&
        requestedStatus !== "REJECTED"
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid withdrawal status."
        });
      }

      const requests = await readRequests();

      const index = requests.findIndex(function (request) {
        return String(request.id) === String(id);
      });

      if (index === -1) {
        return res.status(404).json({
          success: false,
          message:
            "Withdrawal request not found."
        });
      }

      const currentStatus =
        String(
          requests[index].status || ""
        ).toUpperCase();

      // Prevent double approval / double deduction
      if (currentStatus !== "PENDING") {
        return res.status(409).json({
          success: false,
          message:
            "This withdrawal has already been processed.",
          request: requests[index]
        });
      }

      const processedAt =
        new Date().toISOString();

      requests[index].status =
        requestedStatus;

      requests[index].processedAt =
        processedAt;

      requests[index].processedBy =
        "admin";

      // APPROVED
      if (requestedStatus === "APPROVED") {
        requests[index].approvedAt =
          processedAt;
      }

      // REJECTED
      if (requestedStatus === "REJECTED") {
        requests[index].rejectedAt =
          processedAt;
      }

      await saveRequests(requests);

      return res.status(200).json({
        success: true,
        request: requests[index]
      });
    }

    // =========================
    // METHOD NOT ALLOWED
    // =========================
    return res.status(405).json({
      success: false,
      message: "Method not allowed."
    });

  } catch (error) {
    console.error(
      "Withdrawal API error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Withdrawal server error."
    });
  }
}
