import express from "express";
import dotenv from "dotenv";
import dbRoutes from "./routes/dbRoutes.js";
import cors from "cors";
import { sendIndividualCheckout } from "./controllers/dbController.js";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 8080;

app.use(
  cors({
    origin: ["http://localhost:8081", "http://46.62.157.49"], // allowed origins
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // For form data

app.use("/api/db", dbRoutes);

// app.use("/api/website", websiteRoutes);
// app.use("/api/auth", authRoutes);
// app.use("/api/payment", stripeRoutes);

app.get("/", (req, res) => {
  res.send("✅ Server is up and running!");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on port ", PORT);
});
