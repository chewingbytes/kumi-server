import express from "express";
import { checkIn, checkOut, fetchStudents, finishDay, latestStatus, submitStudents } from "../controllers/dbController.js";
const router = express.Router();

router.post("/checkin", checkIn);
router.post("/checkout", checkOut);
router.post("/students", submitStudents);
router.get("/status/:name", latestStatus);
router.get("/students", fetchStudents);
router.post("/finish-day", finishDay)

export default router;