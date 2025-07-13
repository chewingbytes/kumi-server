import express from "express";
import dotenv from "dotenv";
import dbRoutes from "./routes/dbRoutes.js";
dotenv.config();

const app = express();

const PORT = process.env.PORT || 4000;

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // For form data

app.use("/api/db", dbRoutes);

// app.use("/api/website", websiteRoutes);
// app.use("/api/auth", authRoutes);
// app.use("/api/payment", stripeRoutes);

app.listen(4000, "0.0.0.0", () => {
  console.log("Listening on port 4000");
});
