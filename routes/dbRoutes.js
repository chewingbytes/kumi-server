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
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : null;

    if (!token) {
      return res.status(401).json({ error: "Missing access token" });
    }

    // Verify user token
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser(token);

    if (userError || !user) {
      console.error("Auth Error:", userError);
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const userId = user.id;

    const results = [];
    const filePath = path.resolve(req.file.path); // full absolute path
    console.log("Uploaded file path:", filePath);

    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (data) => {
        // Assume CSV columns: name,parent,parentEmail
        results.push({
          studentName: data.studentName,
          parentNumber: data.parentNumber,
        });
      })
      .on("error", (err) => {
        console.error("Stream error:", err);
        res.status(500).json({ error: "Failed to read CSV file." });
      })
      .on("close", async () => {
        await fsPromises.unlink(filePath);

        if (!results.length) {
          return res.status(400).json({ error: "CSV file is empty" });
        }

        try {
          // Loop through each student entry and insert parent & student
          for (const s of results) {
            if (!s.studentName || !s.parentNumber) {
              return res.status(400).json({
                error: "Missing fields for one or more students in CSV",
              });
            }

            // Step 1: Check if parent already exists by email
            const { data: existingParent, error: lookupError } = await supabase
              .from("parents")
              .select("id")
              .eq("phone_number", s.parentNumber)
              .eq("user_id", userId) // optional: check it's this user's parent
              .single();

            let parentId;

            if (lookupError && lookupError.code !== "PGRST116") {
              // Only throw if the error is not "No rows returned"
              throw new Error(lookupError.message);
            }

            if (existingParent) {
              parentId = existingParent.id;
            } else {
              // Step 2: Insert new parent if not found
              const { data: newParent, error: insertError } = await supabase
                .from("parents")
                .insert([{ phone_number: s.parentNumber, user_id: userId }])
                .select("id")
                .single();

              if (insertError || !newParent) {
                throw new Error(
                  insertError?.message || "Failed to insert parent"
                );
              }

              parentId = newParent.id;
            }

            // Step 3: Insert the student linked to the parentId
            const { error: studentError } = await supabase
              .from("students")
              .insert([
                { name: s.studentName, parent_id: parentId, user_id: userId },
              ]);

            if (studentError) throw new Error(studentError.message);
          }

          res.status(200).json({
            message: "All students added successfully",
            studentsCount: results.length,
          });
        } catch (err) {
          console.error("Error inserting students:", err.message);
          res.status(500).json({ error: err.message });
        }
      });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
