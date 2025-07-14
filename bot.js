import { Bot, session } from "grammy";
import { Resend } from "resend";
import { supabaseAdapter } from "@grammyjs/storage-supabase"; // <-- named import
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import crypto from "crypto";
import nodemailer from "nodemailer";

dotenv.config();

const bot_token = process.env.TELEGRAM_API_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ROLE_KEY;
const smtp2go_user = process.env.SMTP2GO_USER;
const smtp2go_pass = process.env.SMTP2GO_PASS;

const supabase = createClient(supabaseUrl, supabaseKey);

/* ── storage adapter ───────────────────────── */
const storage = supabaseAdapter({
  supabase,
  table: "sessions",
});

function initialSession() {
  return {
    state: "idle",
    parentId: null,
  };
}

/* ── bot setup ─────────────────────────────── */
const bot = new Bot(bot_token);
bot.use(
  session({
    initial: () => ({
      state: "idle",
      parentId: null,
    }),
    storage,
  })
);

// Helper: generate secret key
function generateSecretKey() {
  return crypto.randomBytes(3).toString("hex").toUpperCase(); // e.g. 'A1B2C3'
}

// create reusable SMTP transporter
const smtpTransport = nodemailer.createTransport({
  host: "mail.smtp2go.com",
  port: 2525, // also works: 8025, 587, 25
  auth: {
    user: smtp2go_user,
    pass: smtp2go_pass,
  },
});

export async function sendSecretEmail(toEmail, parentName, secretKey) {
  try {
    const info = await smtpTransport.sendMail({
      from: '"KumiBot - Offical Telegram Bot of Kumon @ Punggol Plaza" <no-reply@kumonpunggolplaza.com>',
      to: toEmail,
      subject: "Your Kumon Login Secret Key",
      text: `Hello ${parentName}, your secret key is: ${secretKey}`,
      html: `<p>Hello ${parentName},</p>
             <p>Your one-time secret key is:</p>
             <h2>${secretKey}</h2>
             <p>Enter this key in the Telegram bot to complete login.</p>`,
    });

    console.log("📧 Message sent:", info.messageId || info.response);
    return true;
  } catch (err) {
    console.error("❌ Email send error:", err);
    return false;
  }
}

// /start command
bot.command("start", async (ctx) => {
  await ctx.reply(
    "Welcome! 🎓\n\n" +
      "Use /login to authenticate.\n" +
      "Once logged in, use /your-students to view your student list.\n" +
      "Use /add-new-students to register new students."
  );
});

// /login command
bot.command("login", async (ctx) => {
  ctx.session.state = "awaitingLoginInfo";
  ctx.session.parentId = null;
  await ctx.reply(
    "Please send your name and email separated by a comma.\nExample:\nJohn Doe, john@example.com"
  );
});

// /logout command
bot.command("logout", async (ctx) => {
  ctx.session = initialSession();
  await ctx.reply("You have been logged out.");
});

// /your-students command
bot.command("your_students", async (ctx) => {
  if (ctx.session.state !== "loggedIn") {
    return ctx.reply("Please login first using /login.");
  }

  const { data: students, error } = await supabase
    .from("students")
    .select("name")
    .eq("parent_id", ctx.session.parentId);

  if (error) {
    return ctx.reply("Error fetching students: " + error.message);
  }

  if (students.length === 0) {
    return ctx.reply("You have no registered students.");
  }

  const message = students
    .map((s, i) => `${i + 1}. ${s.name}`)
    .join("\n");
  await ctx.reply(`👩‍🎓 Your students:\n\n${message}`);
});

// Handle /done command to exit add new student mode
bot.command("done", async (ctx) => {
  if (ctx.session.state === "awaitingNewStudent") {
    ctx.session.state = "loggedIn";
    ctx.session.newStudents = [];
    await ctx.reply("Finished adding students.");
  } else {
    await ctx.reply("Nothing to finish currently.");
  }
});

// Handle incoming messages depending on session state
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();

  switch (ctx.session.state) {
    case "awaitingLoginInfo": {
      if (!text.includes(",") || !text.includes("@")) {
        return ctx.reply(
          "Please send your name and email separated by a comma, e.g. John Doe, john@example.com"
        );
      }
      const [nameRaw, emailRaw] = text.split(",");
      const name = nameRaw.trim();
      const email = emailRaw.trim();

      // Check parent in DB
      const { data: parents, error } = await supabase
        .from("parents")
        .select("*")
        .eq("name", name)
        .eq("email", email)
        .limit(1)
        .single();

      if (error || !parents) {
        return ctx.reply(
          "Parent not found. Please try again or contact support."
        );
      }

      // Generate and save secret key
      const secretKey = generateSecretKey();

      const { error: updateError } = await supabase
        .from("parents")
        .update({ secret_key: secretKey })
        .eq("id", parents.id);

      if (updateError) {
        return ctx.reply(
          "Error generating secret key. Please try again later."
        );
      }

      const emailSent = await sendSecretEmail(email, name, secretKey);
      if (!emailSent) {
        return ctx.reply("⚠️ Couldn't send the email. Please try again later.");
      }

      ctx.session.state = "awaitingSecretKey";
      ctx.session.parentId = parents.id;

      return ctx.reply(
        "A secret key has been sent to your email.\nPlease enter the secret key here to complete login."
      );
    }

    case "awaitingSecretKey": {
      if (text.toUpperCase() === (await getSecretKey(ctx.session.parentId))) {
        ctx.session.state = "loggedIn";
        await ctx.reply(
          "✅ Login successful! You can now use the bot commands."
        );
      } else {
        await ctx.reply("❌ Incorrect secret key. Please try again.");
      }
      break;
    }

    default:
      await ctx.reply("Unknown command or please login first with /login.");
  }
});

// Helper to get secret key from DB for parentId
async function getSecretKey(parentId) {
  const { data, error } = await supabase
    .from("parents")
    .select("secret_key")
    .eq("id", parentId)
    .limit(1)
    .single();

  if (error || !data) return null;
  return data.secret_key;
}

bot.start();
