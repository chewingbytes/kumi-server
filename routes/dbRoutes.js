import supabase from "../config/supabase.js";
import express from "express";
import {
  checkIn,
  checkOut,
  fetchAllStudents,
  fetchStudents,
  finishDay,
  latestStatus,
  sendIndividualCheckout,
  submitStudents,
  deleteStudent,
  getParentNumber,
  updateStudent,
  deleteStudentRow,
  fetchHomeScreenStudents,
  fetchAttendanceDates,
  fetchAttendanceByDate,
  fetchCurrentCheckins,
} from "../controllers/dbController.js";
const router = express.Router();
import multer from "multer";
import csv from "csv-parser";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import crypto from "node:crypto";

const upload = multer({ dest: "uploads/" });

const VERIFY_TOKEN = "kumonpunggolplazamessagetoken";

router.post("/get-parent-number", getParentNumber);
router.post("/update-student", updateStudent);
router.delete("/:id", deleteStudent);
router.post("/delete-student", deleteStudentRow);
router.post("/checkin", checkIn);
router.post("/checkout", checkOut);
router.post("/sendMessage", sendIndividualCheckout);
router.post("/students", submitStudents);
router.get("/homescreenstudents", fetchHomeScreenStudents);
router.get("/status/:name", latestStatus);
router.get("/students", fetchStudents);
router.get("/all-students", fetchAllStudents);
router.post("/finish-day", finishDay);
router.get("/records/dates", fetchAttendanceDates);
router.get("/records/by-date", fetchAttendanceByDate);
router.get("/records/current", fetchCurrentCheckins);

router.post("/upload-csv", upload.single("file"), async (req, res) => {
  console.log("=== /upload-csv called ===");

  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : null;

    if (!token) {
      console.log("❌ Missing access token");
      return res.status(401).json({ error: "Missing access token" });
    }

    console.log("✅ Token received");

    // Verify user token
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser(token);

    if (userError || !user) {
      console.error("❌ Auth Error:", userError);
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const userId = user.id;
    console.log("✅ Authenticated user:", user.email, "ID:", userId);

    if (!req.file) {
      console.error("❌ No file received");
      return res.status(400).json({ error: "No file uploaded" });
    }

    const filePath = path.resolve(req.file.path);
    console.log("📂 Uploaded file path:", filePath);

    const results = [];

    // ✅ Setup CSV stream
    const stream = fs
      .createReadStream(filePath)
      .pipe(csv())
      .on("headers", (headers) => {
        console.log("🧾 CSV Headers detected:", headers);
      })
      .on("data", (data) => {
        console.log("➡️ CSV Row:", data);
        results.push({
          studentName: data.studentName?.trim(),
          parentNumber: data.parentNumber?.trim(),
        });
      })
      .on("error", (err) => {
        console.error("❌ CSV Stream error:", err);
        res.status(500).json({ error: "Failed to read CSV file." });
      })
      .on("end", async () => {
        console.log("✅ CSV parsing completed, total rows:", results.length);
        await fsPromises.unlink(filePath);
        console.log("🧹 Temp file deleted");

        if (!results.length) {
          console.log("❌ CSV file empty");
          return res.status(400).json({ error: "CSV file is empty" });
        }

        try {
          for (const [index, s] of results.entries()) {
            console.log(`📥 Processing row ${index + 1}:`, s);

            if (!s.studentName || !s.parentNumber) {
              console.warn("⚠️ Missing data:", s);
              return res.status(400).json({
                error: "Missing fields for one or more students in CSV",
              });
            }

            // Check if parent already exists
            const { data: existingParent, error: lookupError } = await supabase
              .from("parents")
              .select("id")
              .eq("phone_number", s.parentNumber)
              .eq("user_id", userId)
              .maybeSingle();

            if (lookupError) {
              console.error("❌ Parent lookup error:", lookupError);
              throw new Error(lookupError.message);
            }

            let parentId = existingParent?.id;
            if (parentId) {
              console.log("👨‍👧 Existing parent found:", parentId);
            } else {
              console.log("🆕 Creating new parent for:", s.parentNumber);
              const { data: newParent, error: insertError } = await supabase
                .from("parents")
                .insert([{ phone_number: s.parentNumber, user_id: userId }])
                .select("id")
                .single();

              if (insertError) {
                console.error("❌ Parent insert error:", insertError);
                throw new Error(insertError.message);
              }
              parentId = newParent.id;
              console.log("✅ New parent created:", parentId);
            }

            // Insert student
            const { error: studentError } = await supabase
              .from("students")
              .insert([
                { name: s.studentName, parent_id: parentId, user_id: userId },
              ]);

            if (studentError) {
              console.error("❌ Student insert error:", studentError);
              throw new Error(studentError.message);
            }

            console.log(`✅ Student added: ${s.studentName}`);
          }

          console.log("🎉 All students processed successfully");
          res.status(200).json({
            message: "All students added successfully",
            studentsCount: results.length,
          });
        } catch (err) {
          console.error("❌ Insert logic error:", err.message);
          res.status(500).json({ error: err.message });
        }
      });

    // ✅ Catch any unhandled stream error
    stream.on("error", (err) => {
      console.error("❌ Fatal stream error:", err);
      res.status(500).json({ error: "Stream error occurred" });
    });
  } catch (error) {
    console.error("❌ Outer try/catch error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/webhooks", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("Webhook verify:", { mode, token, challenge });

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }

  console.warn("❌ Webhook verification failed");
  return res.sendStatus(403);
});

router.post("/webhooks", async (req, res) => {
  const webhookId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  console.log("📨 Webhook received", {
    webhookId,
    method: req.method,
    path: req.originalUrl,
    contentLength: req.headers["content-length"],
    userAgent: req.headers["user-agent"],
    signature: req.headers["x-hub-signature-256"],
  });

  try {
    // ---------------------------
    // 1️⃣ Validate signature
    // ---------------------------
    const signatureHeader = req.headers["x-hub-signature-256"];
    const appSecret = process.env.META_APP_SECRET;
    const rawBody = req.rawBody;

    if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
      console.error("❌ Missing or invalid signature header", { webhookId });
      return res.sendStatus(400);
    }

    if (!appSecret || !rawBody) {
      console.error("❌ Missing META_APP_SECRET or raw body", { webhookId });
      return res.sendStatus(400);
    }

    const expectedHash =
      "sha256=" +
      crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");

    if (signatureHeader !== expectedHash) {
      console.error("❌ Invalid webhook signature", {
        webhookId,
        signature: signatureHeader,
        expectedHash,
      });
      return res.sendStatus(400);
    }

    // Valid request
    res.sendStatus(200);

    const body = req.body;
    console.log("WEBHOOK BODY RAW:", JSON.stringify(req.body, null, 2));
    if (!body?.entry?.length) return;

    for (const entry of body.entry) {
      for (const change of entry.changes ?? []) {
        const value = change.value;

        // ---------------------------
        // 📨 Incoming messages (from user)
        // ---------------------------
        if (value?.messages?.length) {
          for (const msg of value.messages) {
            const record = {
              whatsapp_message_id: msg.id,
              from_number: msg.from,
              type: msg.type,
              text: msg.text?.body ?? null,
              timestamp: new Date(Number(msg.timestamp) * 1000),
              raw_payload: msg,
            };

            console.log("📩 Incoming WhatsApp message:", record);

            // const { error } = await supabase
            //   .from("whatsapp_messages")
            //   .insert([record]);

            // if (error) console.error("❌ Failed to save incoming message:", error);
          }
        }

        // ---------------------------
        // 📬 Outgoing messages statuses (sent/delivered/read)
        // ---------------------------
        if (value?.statuses?.length) {
          for (const status of value.statuses) {
            const statusErrors = status.errors ?? [];
            const record = {
              message_id: status.id,
              recipient_id: status.recipient_id,
              status: status.status, // sent, delivered, read
              timestamp: new Date(Number(status.timestamp) * 1000),
              conversation_id: status.conversation?.id ?? null,
              raw_payload: status,
            };

            if (status.status === "failed" || statusErrors.length > 0) {
              console.error("❌ WhatsApp message failed:", {
                ...record,
                errors: statusErrors.map((err) => ({
                  code: err.code,
                  title: err.title,
                  message: err.message,
                  details: err.error_data?.details,
                  href: err.href,
                })),
              });
            } else {
              console.log("✅ WhatsApp message status:", record);
            }

            const rawRecipient = status.recipient_id?.toString() ?? "";
            let recipientDigits = rawRecipient.replace(/\D/g, "");
            if (
              recipientDigits.startsWith("65") &&
              recipientDigits.length > 8
            ) {
              recipientDigits = recipientDigits.slice(2);
            }

            if (recipientDigits) {
              const { data: parent, error: parentErr } = await supabase
                .from("parents")
                .select("id")
                .eq("phone_number", recipientDigits)
                .maybeSingle();

              if (parentErr) {
                console.error("❌ Parent lookup failed:", parentErr);
              } else if (parent?.id) {
                const { data: students, error: studentsErr } = await supabase
                  .from("students")
                  .select("id")
                  .eq("parent_id", parent.id);

                if (studentsErr) {
                  console.error("❌ Students lookup failed:", studentsErr);
                } else if (students?.length) {
                  const statusValue = (
                    status.status ?? "unknown"
                  ).toUpperCase();
                  const isSuccess =
                    statusValue === "SENT" || statusValue === "DELIVERED";
                  const failedReason = !isSuccess
                    ? statusErrors[0]?.message ||
                      statusErrors[0]?.title ||
                      statusErrors[0]?.error_data?.details ||
                      null
                    : null;

                  // Build timestamp fields based on status
                  const baseUpdate = {
                    parent_notified: statusValue,
                    failed_reason: failedReason,
                  };

                  const eventTime = status.timestamp
                    ? new Date(Number(status.timestamp) * 1000).toISOString()
                    : new Date().toISOString();

                  if (statusValue === "SENT" || statusValue === "DELIVERED") {
                    baseUpdate.message_sent_timestamp = eventTime;
                  }

                  if (statusValue === "READ") {
                    baseUpdate.message_read_timestamp = eventTime;
                  }

                  if (statusValue === "FAILED") {
                    baseUpdate.message_failed_timestamp = eventTime;
                  }
                  const studentIds = students.map((s) => s.id);
                  const { error: updateErr } = await supabase
                    .from("students_checkin")
                    .update(baseUpdate)
                    .in("student_id", studentIds);

                  if (updateErr) {
                    console.error(
                      "❌ Failed to update parent_notified:",
                      updateErr,
                    );
                  }
                }
              }
            }

            // const { error } = await supabase
            //   .from("whatsapp_statuses")
            //   .insert([record]);

            // if (error) console.error("❌ Failed to save status:", error);
          }
        }

        // ---------------------------
        // ⚠️ Optional: handle errors (failed messages)
        // ---------------------------
        if (value?.errors?.length) {
          for (const err of value.errors) {
            console.error("❌ WhatsApp message error:", err);
            // Optional: store in a table for monitoring
          }
        }
      }
    }
  } catch (err) {
    console.error("❌ Webhook processing error:", err);
  }
});

export default router;
