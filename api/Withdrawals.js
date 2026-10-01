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

export default async function handler(req, res) {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

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

    /* =========================
       GET REQUESTS
    ========================= */

    if (req.method === "GET") {

      const requests = await readRequests();

      return res.status(200).json({
        success: true,
        requests
      });
    }


    /* =========================
       CREATE REQUEST
    ========================= */

    if (req.method === "POST") {

      const body =
        typeof req.body === "string"
          ? JSON.parse(req.body)
          : req.body || {};

      const {
        employeeName,
        employeeId,
        username,
        referral,
        amount,
        phone
      } = body;

      if (
        !employeeName ||
        !employeeId ||
        !username ||
        !referral ||
        !amount ||
        !phone
      ) {
        return res.status(400).json({
          success: false,
          message: "Missing withdrawal information."
        });
      }

      const numericAmount =
        Number(amount);

      if (
        !Number.isFinite(numericAmount) ||
        numericAmount <= 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid withdrawal amount."
        });
      }

      const cleanPhone =
        String(phone).trim();

      if (!/^07\d{8}$/.test(cleanPhone)) {
        return res.status(400).json({
          success: false,
          message: "Invalid Kenyan phone number."
        });
      }

      const requests =
        await readRequests();

      const pending =
        requests.some(request =>
          String(request.employeeId) ===
            String(employeeId) &&
          String(
            request.status || ""
          ).toUpperCase() === "PENDING"
        );

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
          Math.random()
            .toString(36)
            .slice(2, 8),

        employeeName:
          String(employeeName),

        employeeId:
          String(employeeId),

        username:
          String(username),

        referral:
          String(referral),

        amount:
          numericAmount,

        phone:
          cleanPhone,

        status:
          "PENDING",

        createdAt:
          new Date().toISOString()
      };

      requests.push(newRequest);

      await saveRequests(requests);

      return res.status(201).json({
        success: true,
        request: newRequest
      });
    }


    /* =========================
       UPDATE REQUEST
       ADMIN APPROVE / REJECT
    ========================= */

    if (req.method === "PUT") {

      const body =
        typeof req.body === "string"
          ? JSON.parse(req.body)
          : req.body || {};

      const {
        id,
        status
      } = body;

      if (!id || !status) {
        return res.status(400).json({
          success: false,
          message:
            "Request ID and status are required."
        });
      }

      const cleanStatus =
        String(status).toUpperCase();

      if (
        cleanStatus !== "APPROVED" &&
        cleanStatus !== "REJECTED"
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid withdrawal status."
        });
      }

      const requests =
        await readRequests();

      const index =
        requests.findIndex(
          request =>
            String(request.id) ===
            String(id)
        );

      if (index === -1) {
        return res.status(404).json({
          success: false,
          message:
            "Withdrawal request not found."
        });
      }

      requests[index].status =
        cleanStatus;

      requests[index].processedAt =
        new Date().toISOString();

      requests[index].processedBy =
        "admin";

      if (
        cleanStatus === "APPROVED"
      ) {
        requests[index].approvedAt =
          requests[index].processedAt;
      }

      await saveRequests(requests);

      return res.status(200).json({
        success: true,
        request: requests[index]
      });
    }


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
      message:
        "Withdrawal server error."
    });
  }
      }
