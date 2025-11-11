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
} from "../controllers/dbController.js";
const router = express.Router();
import multer from "multer";
import csv from "csv-parser";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";

const upload = multer({ dest: "uploads/" });

router.post("/checkin", checkIn);
router.post("/checkout", checkOut);
router.post("/sendMessage", sendIndividualCheckout);
router.post("/students", submitStudents);
router.get("/status/:name", latestStatus);
router.get("/students", fetchStudents);
router.get("/all-students", fetchAllStudents);
router.post("/finish-day", finishDay);

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

export default router;
