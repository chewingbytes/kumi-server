import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, "..", ".env") });

console.log("Supabase URL:", process.env.SUPABASE_URL);
console.log("Supabase Role Key:", process.env.SUPABASE_ROLE_KEY ? "Loaded" : "Not Loaded");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ROLE_KEY);

export default supabase;
