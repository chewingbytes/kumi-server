// routes/students.js
import supabase from "../config/supabase.js";
import ExcelJS from "exceljs";
import fs from "fs";
import path from "path";

import nodemailer from "nodemailer";

const smtpTransport = nodemailer.createTransport({
  host: "mail.smtp2go.com",
  port: 2525, // also works: 8025, 587, 25
  auth: {
    user: process.env.SMTP2GO_USER,
    pass: process.env.SMTP2GO_PASS,
  },
});

async function sendCheckoutEmail(
  toEmail,
  parentName,
  studentName,
  checkoutTime
) {
  const formattedTime = new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date(checkoutTime.replace(" ", "T")));

  try {
    const info = await smtpTransport.sendMail({
      from: "Kumon @ Punggol Plaza <no-reply@kumonpunggolplaza.com>",
      to: toEmail,
      subject: `Your child ${studentName} has checked out`,
      text: `Hello ${parentName},\n\nThis is to inform you that your child, ${studentName}, has checked out at ${formattedTime}.\n\nBest regards,\nKumon Punggol Plaza`,
      html: `<p>Hello ${parentName},</p>
             <p>This is to inform you that your child, <strong>${studentName}</strong>, has checked out at <strong>${formattedTime}</strong>.</p>
             <p>Best regards,<br/>Kumon Punggol Plaza</p>`,
    });

    console.log("📧 Checkout email sent:", info.messageId || info.response);
    return true;
  } catch (err) {
    console.error("❌ Email send error:", err);
    return false;
  }
}

/* ──────────────── 1️⃣  Check‑in (POST /checkin) ──────────────── */
export const checkIn = async (req, res) => {
  try {
    const { name } = req.body;
    const sgTime = new Date().toISOString();
    const now = new Date();
    const dateOnly = now.toISOString().split("T")[0]; // e.g. "2025-07-15"

    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : null;

    if (!token) {
      return res.status(401).json({ error: "Missing access token" });
    }

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser(token);

    if (userError || !user) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    // 1. Find student
    const { data: student, error: studentErr } = await supabase
      .from("students")
      .select("id, name")
      .eq("user_id", user.id) // Filter by user
      .ilike("name", name)
      .limit(1)
      .single();

    if (studentErr || !student) {
      return res.status(404).json({ error: "Student not found" });
    }

    // 2. Upsert latest check‑in row
    const { data: last } = await supabase
      .from("students_checkin")
      .select("id")
      .eq("student_id", student.id)
      .eq("user_id", user.id)
      .order("checkin_time", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (last) {
      // UPDATE
      const { error: upErr } = await supabase
        .from("students_checkin")
        .update({
          checkin_time: sgTime,
          checkout_time: null,
          status: "checked_in",
          parent_notified: false,
          time_spent: null,
          user_id: user.id,
          date: dateOnly, // Add the date here
        })
        .eq("id", last.id);
      if (upErr) throw upErr;
      return res.json({ message: "re‑checked in", rowId: last.id });
    } else {
      // INSERT
      const { data, error: inErr } = await supabase
        .from("students_checkin")
        .insert({
          student_id: student.id,
          student_name: student.name,
          checkin_time: sgTime,
          status: "checked_in",
          user_id: user.id,
          date: dateOnly, // Add the date here
        })
        .select("id")
        .single();
      if (inErr) throw inErr;
      return res.json({ message: "checked in", rowId: data.id });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
};

/* ──────────────── 2️⃣  Check‑out (POST /checkout) ──────────────── */
export const checkOut = async (req, res) => {
  try {
    const { name } = req.body;
    const sgTime = new Date().toISOString();

    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : null;

    if (!token) {
      return res.status(401).json({ error: "Missing access token" });
    }

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser(token);

    if (userError || !user) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const { data: row, error } = await supabase
      .from("students_checkin")
      .select("student_id, status, checkin_time")
      .ilike("student_name", name)
      .eq("user_id", user.id) // Filter by user
      .order("checkin_time", { ascending: false })
      .limit(1)
      .single();

    if (error || !row) {
      return res.status(404).json({ error: "No active check‑in found" });
    }
    if (row.status === "checked_out") {
      return res.status(400).json({ error: "Already checked out" });
    }

    const checkinTime = new Date(row.checkin_time);
    const checkoutTime = new Date(sgTime);
    const diffMs = checkoutTime - checkinTime;
    const timeSpentMinutes = Math.floor(diffMs / 60000); // 1 min = 60000 ms

    const { error: upErr } = await supabase
      .from("students_checkin")
      .update({
        checkout_time: sgTime,
        status: "checked_out",
        time_spent: timeSpentMinutes,
      })
      .eq("student_id", row.student_id)
      .eq("user_id", user.id);

    if (upErr) throw upErr;

    const { data: studentData, error: studentErr } = await supabase
      .from("students")
      .select("parent_id, name")
      .eq("id", row.student_id)
      .eq("user_id", user.id) // Filter by user
      .single();

    if (studentErr || !studentData) {
      console.warn("⚠️ Student not found or no parent_id");
      return res.json({ message: "checked out", rowId: row.id });
    }

    // 4. Fetch parent info (name, email) by parent_id
    const { data: parentData, error: parentErr } = await supabase
      .from("parents")
      .select("name, email")
      .eq("id", studentData.parent_id)
      .eq("user_id", user.id)
      .single();

    if (parentErr || !parentData?.email) {
      console.warn("⚠️ Parent not found or no email");
      return res.json({ message: "checked out", rowId: row.id });
    }

    // 5. Send email to parent (fire and forget)
    const emailSent = sendCheckoutEmail(
      parentData.email,
      parentData.name || "Parent",
      studentData.name,
      sgTime
    );

    if (emailSent) {
      await supabase
        .from("students_checkin")
        .update({ parent_notified: true })
        .eq("student_id", row.student_id)
        .eq("user_id", user.id); // Filter by user
    }

    res.json({ message: "checked out", rowId: row.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
};

/* ──────────────── 3️⃣  Get latest status (GET /status/:name) ──────────────── */
export const latestStatus = async (req, res) => {
  try {
    const { name } = req.params;

    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : null;

    if (!token) {
      return res.status(401).json({ error: "Missing access token" });
    }

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser(token);

    if (userError || !user) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const { data, error } = await supabase
      .from("students_checkin")
      .select("*")
      .ilike("student_name", name)
      .eq("user_id", user.id) // Filter by user
      .order("checkin_time", { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      return res.status(404).json({ found: false });
    }
    res.json({ found: true, record: data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
};

export const finishDay = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : null;

    if (!token) {
      return res.status(401).json({ error: "Missing access token" });
    }

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser(token);

    if (userError || !user) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const { data, error } = await supabase
      .from("students_checkin")
      .select("student_name, status, parent_notified, time_spent, date, checkin_time, checkout_time")
      .eq("user_id", user.id) // Filter by user
      .order("checkin_time", { ascending: false });

    if (error) throw error;

    if (!data || data.length === 0) {
      return res.status(404).json({ error: "No check-in records found" });
    }

    const formattedData = data.map((row) => {
      const mins = row.time_spent || 0;
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return {
        ...row,
        time_spent: h > 0 ? `${h}h ${m}m` : `${m}m`,
      };
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Checkins");

    // Header row styling (light blue background, bold)
    const headers = Object.keys(formattedData[0]);
    worksheet.addRow(headers);
    const headerRow = worksheet.getRow(1);
    headerRow.eachCell((cell) => {
      cell.font = { bold: true };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "D9E1F2" }, // light blue
      };
      cell.border = {
        top: { style: "thin" },
        left: { style: "thin" },
        bottom: { style: "thin" },
        right: { style: "thin" },
      };
    });

    // Add each data row with conditional coloring
    formattedData.forEach((row) => {
      const values = headers.map((key) => row[key]);
      const newRow = worksheet.addRow(values);

      const isComplete = row.checkin_time && row.checkout_time;
      const fillColor = isComplete ? "E0F7FA" : "FCE4EC"; // green or red

      newRow.eachCell((cell) => {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: fillColor },
        };
        cell.border = {
          top: { style: "thin" },
          left: { style: "thin" },
          bottom: { style: "thin" },
          right: { style: "thin" },
        };
      });
    });

    // Optional: Auto-width for all columns
    worksheet.columns.forEach((col) => {
      let maxLength = 10;
      col.eachCell({ includeEmpty: true }, (cell) => {
        const val = cell.value ? cell.value.toString() : "";
        if (val.length > maxLength) maxLength = val.length;
      });
      col.width = maxLength + 2;
    });

    // Final buffer export
    const buffer = await workbook.xlsx.writeBuffer();

    // Send email with Excel attachment
    const info = await smtpTransport.sendMail({
      from: "Kumon @ Punggol Plaza <no-reply@kumonpunggolplaza.com>",
      to: "bryanchewzy24@gmail.com", // Replace with real email or from req.body
      subject: `📄 Daily Check-in Report - ${new Date().toLocaleDateString("en-SG")}`,
      text: `Please find attached the daily student check-in/out report.`,
      attachments: [
        {
          filename: `checkins_${new Date().toISOString().slice(0, 10)}.xlsx`,
          content: buffer,
          contentType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      ],
    });

    console.log("📧 Report email sent:", info.messageId || info.response);

    const { error: insertErr } = await supabase.from("records").insert(data);
    if (insertErr) throw insertErr;

    // --- NEW: Delete all entries from students_checkin ---
    const { error: deleteErr } = await supabase
      .from("students_checkin")
      .delete()
      .eq("user_id", user.id);
    if (deleteErr) throw deleteErr;

    res.json({
      message:
        "Report generated, emailed, data archived, and check-ins cleared.",
    });
  } catch (err) {
    console.error("❌ finishDay error:", err);
    res.status(500).json({ error: "Failed to generate or send report" });
  }
};

export async function fetchStudents(req, res) {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : null;

    if (!token) {
      return res.status(401).json({ error: "Missing access token" });
    }

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser(token);

    if (userError || !user) {
      console.error("Auth Error:", userError);
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const userId = user.id; // will be stored in students.user_id

    const { data, error } = await supabase
      .from("students_checkin")
      .select(
        `id, student_id, student_name, checkin_time, checkout_time, status, parent_notified, students(name)`
      )
      .eq("user_id", userId)
      .order("checkin_time", { ascending: true });

    if (error) throw error;

    res.status(200).json({ students: data });
  } catch (err) {
    console.error("Error fetching students:", err.message);
    res.status(500).json({ error: err.message });
  }
}

export async function fetchAllStudents(req, res) {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : null;

    if (!token) {
      return res.status(401).json({ error: "Missing access token" });
    }

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser(token);

    if (userError || !user) {
      console.error("Auth Error:", userError);
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const userId = user.id; // will be stored in students.user_id

    const { data, error } = await supabase
      .from("students")
      .select(
        `
    id,
    name,
    parent_id,
    parents (
      id,
      name,
      email
    )
  `
      )
      .eq("user_id", userId) // only on students table
      .order("name", { ascending: true });

    if (error) throw error;

    res.status(200).json({ students: data });
  } catch (err) {
    console.error("Error fetching students:", err.message);
    res.status(500).json({ error: err.message });
  }
}

export async function submitStudents(req, res) {
  const students = req.body.students; // expects an array [{ name, parent, parentEmail }]

  if (!Array.isArray(students) || students.length === 0) {
    return res.status(400).json({ error: "No students to submit" });
  }

  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : null;

    if (!token) {
      return res.status(401).json({ error: "Missing access token" });
    }

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser(token);

    if (userError || !user) {
      console.error("Auth Error:", userError);
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const userId = user.id; // will be stored in students.user_id

    for (const s of students) {
      if (!s.name || !s.parent || !s.parentEmail) {
        return res.status(400).json({ error: "Missing fields for a student" });
      }

      // Insert parent
      const { data: existingParent, error: lookupError } = await supabase
        .from("parents")
        .select("id")
        .eq("email", s.parentEmail)
        .eq("user_id", userId) // optional: check it's this user's parent
        .single();

      let parentId;

      if (lookupError && lookupError.code !== "PGRST116") {
        throw new Error(lookupError.message);
      }

      if (existingParent) {
        parentId = existingParent.id;
      } else {
        // Step 2: Insert new parent if not found
        const { data: newParent, error: insertError } = await supabase
          .from("parents")
          .insert([{ name: s.parent, email: s.parentEmail, user_id: userId }])
          .select("id")
          .single();

        if (insertError || !newParent) {
          throw new Error(insertError?.message || "Failed to insert parent");
        }

        parentId = newParent.id;
      }

      // Step 3: Insert the student linked to the parentId
      const { error: studentError } = await supabase
        .from("students")
        .insert([{ name: s.name, parent_id: parentId, user_id: userId }]);

      if (studentError) throw new Error(studentError.message);
    }

    res.status(200).json({ message: "All students added successfully" });
  } catch (err) {
    console.error("Error submitting students:", err.message);
    res.status(500).json({ error: err.message });
  }
}
