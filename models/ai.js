import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import Together from "together-ai";
import supabase from "../config/supabase.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, "..", ".env") });

const client = new Together({
  apiKey: process.env.TOGETHER_API_KEY,
});

const SCHEMA_REFERENCE = `You are a Postgres SQL assistant for the Kumon attendance platform. You must rely only on the following Supabase tables when you generate SQL.

Table attendance_days
- id bigint primary key
- user_id uuid
- date date
- created_at timestamptz

Table attendance_records
- id bigint primary key
- day_id bigint (FK -> attendance_days.id)
- user_id uuid
- student_id bigint
- student_name text
- status text
- parent_notified text
- time_spent text
- checkin_time timestamptz
- checkout_time timestamptz
- date date
- created_at timestamptz
- failed_reason text

Table parents
- id bigint primary key
- created_at timestamptz
- user_id uuid
- phone_number bigint

Table records
- id bigint primary key
- date date
- student_id bigint
- checkin_time timestamptz
- status text
- student_name text
- checkout_time timestamptz
- parent_notified boolean
- time_spent text
- user_id uuid

Table students
- id bigint primary key
- name text
- parent_id bigint (FK -> parents.id)
- user_id uuid

Table students_checkin
- id bigint primary key
- student_id bigint
- checkin_time timestamptz
- status text
- student_name text
- checkout_time timestamptz
- parent_notified text
- time_spent text
- user_id uuid
- date date
- latest_interacted timestamptz
- failed_reason text

Always return SQL tailored to these columns.`;

const MAX_TOOL_CALL_ITERATIONS = 5;
// Configure the Postgres function name used to execute ad-hoc SQL (must exist in Supabase).
const SQL_EXECUTOR_FUNCTION =
  process.env.SUPABASE_SQL_EXECUTOR_FUNCTION || "execute_ai_sql";

const clampNumber = (value, min, max, fallback) => {
  const num = Number(value);
  if (Number.isFinite(num)) {
    return Math.min(Math.max(num, min), max);
  }
  return fallback;
};

const sanitizeLiteral = (value) => String(value).replace(/'/g, "''");

const isIsoDate = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value.trim());

const isValidUuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value.trim()
  );

const isPlaceholderUserId = (value) => {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return ["user_id", "{{user_id}}", "{{userid}}", "<user_id>", ""].includes(
    normalized
  );
};

const toSqlLiteral = (value, placeholder = "NULL") => {
  if (value === undefined || value === null || value === "") {
    return placeholder;
  }
  return `'${sanitizeLiteral(value)}'`;
};

const toLikeLiteral = (value, placeholder = "'%{{VALUE}}%'") => {
  if (!value) return placeholder;
  const cleaned = String(value).replace(/[%_]/g, " ").trim();
  return `'%' || ${toSqlLiteral(cleaned)} || '%'`;
};

const coalesceUserId = (argsUserId, fallbackUserId) => {
  const sanitizedArg = typeof argsUserId === "string" ? argsUserId.trim() : argsUserId;
  const useFallback =
    !sanitizedArg || isPlaceholderUserId(sanitizedArg) || !isValidUuid(sanitizedArg);
  const finalValue = useFallback ? fallbackUserId : sanitizedArg;
  return toSqlLiteral(finalValue, "'{{USER_ID}}'");
};

const coalesceDate = (value, placeholder = "CURRENT_DATE") => {
  if (value === undefined || value === null || value === "") {
    return placeholder;
  }

  const trimmed = String(value).trim();
  const lowered = trimmed.toLowerCase();

  if (lowered === "today" || lowered === "current_date") {
    return "CURRENT_DATE";
  }

  if (lowered === "yesterday") {
    return "(CURRENT_DATE - INTERVAL '1 day')::date";
  }

  if (lowered === "tomorrow") {
    return "(CURRENT_DATE + INTERVAL '1 day')::date";
  }

  if (isIsoDate(trimmed)) {
    return toSqlLiteral(trimmed);
  }

  return placeholder;
};

const SQL_TOOL_DEFINITIONS = [
  {
    name: "listAttendanceDays",
    description:
      "List recent archived attendance days for a user_id ordered by date descending.",
    parameters: {
      type: "object",
      properties: {
        userId: {
          type: "string",
          description: "UUID of the instructor center.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of days to return (default 30, max 90).",
          minimum: 1,
          maximum: 90,
        },
      },
    },
    build: ({ userId, limit }, options) => {
      const userLiteral = coalesceUserId(userId, options?.userId);
      const resolvedLimit = clampNumber(limit, 1, 90, 30);
      return {
        sql: `SELECT id, date, created_at
FROM attendance_days
WHERE user_id = ${userLiteral}
ORDER BY date DESC
LIMIT ${resolvedLimit};`,
        summary: "Recent archived attendance dates for the selected user.",
      };
    },
  },
  {
    name: "getAttendanceDaySummary",
    description:
      "Summarize attendance metrics (checked in/out/missed) for a specific date.",
    parameters: {
      type: "object",
      properties: {
        userId: { type: "string", description: "UUID of the instructor." },
        date: { type: "string", description: "ISO date (YYYY-MM-DD)." },
      },
    },
    build: ({ userId, date }, options) => {
      const userLiteral = coalesceUserId(userId, options?.userId);
      const dateLiteral = coalesceDate(date, "CURRENT_DATE");
      return {
        sql: `SELECT
  COUNT(*) AS total_records,
  COUNT(*) FILTER (WHERE status = 'checked_in')      AS checked_in,
  COUNT(*) FILTER (WHERE status = 'checked_out')     AS checked_out,
  COUNT(*) FILTER (WHERE checkout_time IS NULL)      AS missing_checkout,
  COUNT(*) FILTER (WHERE failed_reason IS NOT NULL) AS failed_attempts
FROM attendance_records
WHERE user_id = ${userLiteral}
  AND date = ${dateLiteral};`,
        summary: "Per-day attendance rollup including missing checkouts and failures.",
      };
    },
  },
  {
    name: "getStudentHistory",
    description:
      "Fetch a student's attendance timeline between two dates (defaults to last 30 days).",
    parameters: {
      type: "object",
      properties: {
        userId: { type: "string", description: "UUID of the instructor." },
        studentName: { type: "string", description: "Full or partial student name." },
        startDate: { type: "string", description: "Start date (YYYY-MM-DD)." },
        endDate: { type: "string", description: "End date (YYYY-MM-DD)." },
        limit: {
          type: "integer",
          description: "Max rows to return (default 50, max 200).",
          minimum: 1,
          maximum: 200,
        },
      },
    },
    build: ({ userId, studentName, startDate, endDate, limit }, options) => {
      const userLiteral = coalesceUserId(userId, options?.userId);
      const nameLiteral = toLikeLiteral(studentName, "'%{{STUDENT_NAME}}%'");
      const startLiteral = coalesceDate(startDate, "(CURRENT_DATE - INTERVAL '30 days')::date");
      const endLiteral = coalesceDate(endDate, "CURRENT_DATE");
      const resolvedLimit = clampNumber(limit, 1, 200, 50);
      return {
        sql: `SELECT date, student_name, status, checkin_time, checkout_time, time_spent, failed_reason
FROM attendance_records
WHERE user_id = ${userLiteral}
  AND student_name ILIKE ${nameLiteral}
  AND date BETWEEN ${startLiteral} AND ${endLiteral}
ORDER BY date DESC, checkin_time DESC
LIMIT ${resolvedLimit};`,
        summary: "Student history with check-in/out times and failure reasons (if any).",
      };
    },
  },
  {
    name: "listOpenCheckins",
    description:
      "List students currently checked in (no checkout_time recorded yet).",
    parameters: {
      type: "object",
      properties: {
        userId: { type: "string", description: "UUID of the instructor." },
      },
    },
    build: ({ userId }, options) => {
      const userLiteral = coalesceUserId(userId, options?.userId);
      return {
        sql: `SELECT student_id, student_name, checkin_time, date, parent_notified, latest_interacted
FROM students_checkin
WHERE user_id = ${userLiteral}
  AND checkout_time IS NULL
ORDER BY checkin_time ASC;`,
        summary: "Active sessions awaiting checkout.",
      };
    },
  },
  {
    name: "listStudentsMissingCheckout",
    description:
      "Show students whose status is still 'checked_in' on a given date to follow up.",
    parameters: {
      type: "object",
      properties: {
        userId: { type: "string" },
        date: { type: "string", description: "ISO date; defaults to today." },
      },
    },
    build: ({ userId, date }, options) => {
      const userLiteral = coalesceUserId(userId, options?.userId);
      const dateLiteral = coalesceDate(date, "CURRENT_DATE");
      return {
        sql: `SELECT student_id, student_name, checkin_time, parent_notified
FROM students_checkin
WHERE user_id = ${userLiteral}
  AND date = ${dateLiteral}
  AND checkout_time IS NULL
ORDER BY checkin_time;`,
        summary: "Same-day students missing checkout records.",
      };
    },
  },
  {
    name: "getParentContactForStudent",
    description: "Fetch parent contact number for a student (fuzzy name search).",
    parameters: {
      type: "object",
      properties: {
        userId: { type: "string" },
        studentName: { type: "string" },
        limit: {
          type: "integer",
          description: "Max matches to show (default 3, max 10).",
          minimum: 1,
          maximum: 10,
        },
      },
    },
    build: ({ userId, studentName, limit }, options) => {
      const userLiteral = coalesceUserId(userId, options?.userId);
      const nameLiteral = toLikeLiteral(studentName, "'%{{STUDENT_NAME}}%'");
      const resolvedLimit = clampNumber(limit, 1, 10, 3);
      return {
        sql: `SELECT s.id AS student_id, s.name AS student_name, p.phone_number
FROM students s
JOIN parents p ON p.id = s.parent_id
WHERE s.user_id = ${userLiteral}
  AND s.name ILIKE ${nameLiteral}
ORDER BY s.name
LIMIT ${resolvedLimit};`,
        summary: "Parent phone numbers to send reminders or updates.",
      };
    },
  },
  {
    name: "getRepeatedNoShows",
    description:
      "Identify students marked with status 'no_show' multiple times (default >=2).",
    parameters: {
      type: "object",
      properties: {
        userId: { type: "string" },
        minOccurrences: {
          type: "integer",
          description: "Minimum number of no-shows to include (default 2).",
          minimum: 1,
          maximum: 20,
        },
        startDate: { type: "string" },
        endDate: { type: "string" },
      },
    },
    build: ({ userId, minOccurrences, startDate, endDate }, options) => {
      const userLiteral = coalesceUserId(userId, options?.userId);
      const startLiteral = coalesceDate(startDate, "(CURRENT_DATE - INTERVAL '90 days')::date");
      const endLiteral = coalesceDate(endDate, "CURRENT_DATE");
      const threshold = clampNumber(minOccurrences, 1, 20, 2);
      return {
        sql: `SELECT student_id, student_name, COUNT(*) AS no_show_count
FROM attendance_records
WHERE user_id = ${userLiteral}
  AND status = 'no_show'
  AND date BETWEEN ${startLiteral} AND ${endLiteral}
GROUP BY student_id, student_name
HAVING COUNT(*) >= ${threshold}
ORDER BY no_show_count DESC, student_name;`,
        summary: "Students frequently absent/no-show for follow-up.",
      };
    },
  },
  {
    name: "getAverageSessionDuration",
    description:
      "Compute average, min, and max session durations (minutes) over a date range.",
    parameters: {
      type: "object",
      properties: {
        userId: { type: "string" },
        startDate: { type: "string" },
        endDate: { type: "string" },
      },
    },
    build: ({ userId, startDate, endDate }, options) => {
      const userLiteral = coalesceUserId(userId, options?.userId);
      const startLiteral = coalesceDate(startDate, "(CURRENT_DATE - INTERVAL '30 days')::date");
      const endLiteral = coalesceDate(endDate, "CURRENT_DATE");
      return {
        sql: `SELECT
  ROUND(AVG(EXTRACT(EPOCH FROM (checkout_time - checkin_time)) / 60.0), 2) AS avg_minutes,
  ROUND(MIN(EXTRACT(EPOCH FROM (checkout_time - checkin_time)) / 60.0), 2) AS min_minutes,
  ROUND(MAX(EXTRACT(EPOCH FROM (checkout_time - checkin_time)) / 60.0), 2) AS max_minutes
FROM attendance_records
WHERE user_id = ${userLiteral}
  AND checkout_time IS NOT NULL
  AND checkin_time IS NOT NULL
  AND date BETWEEN ${startLiteral} AND ${endLiteral};`,
        summary: "Session duration stats for completed visits.",
      };
    },
  },
  {
    name: "getFailedCheckins",
    description:
      "List failed or aborted check-ins with recorded reasons over a date range.",
    parameters: {
      type: "object",
      properties: {
        userId: { type: "string" },
        startDate: { type: "string" },
        endDate: { type: "string" },
      },
    },
    build: ({ userId, startDate, endDate }, options) => {
      const userLiteral = coalesceUserId(userId, options?.userId);
      const startLiteral = coalesceDate(startDate, "(CURRENT_DATE - INTERVAL '14 days')::date");
      const endLiteral = coalesceDate(endDate, "CURRENT_DATE");
      return {
        sql: `SELECT student_id, student_name, failed_reason, checkin_time, date
FROM students_checkin
WHERE user_id = ${userLiteral}
  AND failed_reason IS NOT NULL
  AND failed_reason <> ''
  AND date BETWEEN ${startLiteral} AND ${endLiteral}
ORDER BY checkin_time DESC;`,
        summary: "Operational issues encountered during check-in flows.",
      };
    },
  },
  {
    name: "getDayArchiveDetails",
    description:
      "View full attendance_records for an archived day_id including statuses and parent notifications.",
    parameters: {
      type: "object",
      properties: {
        userId: { type: "string" },
        dayId: { type: "integer", description: "attendance_days.id value." },
      },
    },
    build: ({ userId, dayId }, options) => {
      const userLiteral = coalesceUserId(userId, options?.userId);
      const resolvedDayId = Number.isFinite(Number(dayId)) ? Number(dayId) : "{{DAY_ID}}";
      return {
        sql: `SELECT ar.*
FROM attendance_records ar
JOIN attendance_days ad ON ad.id = ar.day_id
WHERE ar.user_id = ${userLiteral}
  AND ar.day_id = ${resolvedDayId}
ORDER BY ar.student_name, ar.checkin_time;`,
        summary: "Detailed archive for a specific day batch.",
      };
    },
  },
  {
    name: "searchRecordsByStatus",
    description: "Filter attendance_records by status within a date range.",
    parameters: {
      type: "object",
      properties: {
        userId: { type: "string" },
        status: { type: "string", description: "Status value (e.g., checked_in, checked_out, no_show)." },
        startDate: { type: "string" },
        endDate: { type: "string" },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Max rows to return (default 100).",
        },
      },
    },
    build: ({ userId, status, startDate, endDate, limit }, options) => {
      const userLiteral = coalesceUserId(userId, options?.userId);
      const statusLiteral = toSqlLiteral(status, "'checked_in'");
      const startLiteral = coalesceDate(startDate, "(CURRENT_DATE - INTERVAL '30 days')::date");
      const endLiteral = coalesceDate(endDate, "CURRENT_DATE");
      const resolvedLimit = clampNumber(limit, 1, 500, 100);
      return {
        sql: `SELECT *
FROM attendance_records
WHERE user_id = ${userLiteral}
  AND status = ${statusLiteral}
  AND date BETWEEN ${startLiteral} AND ${endLiteral}
ORDER BY date DESC, checkin_time DESC
LIMIT ${resolvedLimit};`,
        summary: "Status-filtered attendance rows.",
      };
    },
  },
  {
    name: "getLatestInteractions",
    description:
      "Show the most recent interactions per student using students_checkin.latest_interacted.",
    parameters: {
      type: "object",
      properties: {
        userId: { type: "string" },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Max students to return (default 50).",
        },
      },
    },
    build: ({ userId, limit }, options) => {
      const userLiteral = coalesceUserId(userId, options?.userId);
      const resolvedLimit = clampNumber(limit, 1, 200, 50);
      return {
        sql: `SELECT student_id, student_name, status, latest_interacted, checkin_time, checkout_time
FROM students_checkin
WHERE user_id = ${userLiteral}
ORDER BY latest_interacted DESC NULLS LAST
LIMIT ${resolvedLimit};`,
        summary: "Recent student touchpoints ordered by latest interaction timestamp.",
      };
    },
  },
];

const SQL_TOOL_MAP = SQL_TOOL_DEFINITIONS.reduce((acc, tool) => {
  acc[tool.name] = tool;
  return acc;
}, {});

const TOGETHER_SQL_TOOLS = SQL_TOOL_DEFINITIONS.map((tool) => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
}));

async function runSupabaseSql(sql) {
  if (!sql) {
    return { error: "No SQL provided" };
  }

  if (!SQL_EXECUTOR_FUNCTION) {
    return { skipped: true, reason: "No Supabase SQL function configured." };
  }

  try {
    console.log("[AI][SQL] Executing via", SQL_EXECUTOR_FUNCTION);
    console.log("[AI][SQL] Query:\n", sql);
    const payload = { sql_text: sql, sql };
    const { data, error } = await supabase.rpc(SQL_EXECUTOR_FUNCTION, payload);

    if (error) {
      console.error("[AI][SQL] Supabase error:", error);
      return {
        error: error.message || "Supabase RPC error",
        details: error,
      };
    }

    console.log("[AI][SQL] Rows returned:", Array.isArray(data) ? data.length : 0);
    return { rows: data };
  } catch (err) {
    console.error("[AI][SQL] Unexpected error:", err);
    return { error: err.message || "Unexpected Supabase error" };
  }
}

async function executeToolCall(name, args, options) {
  const tool = SQL_TOOL_MAP[name];
  if (!tool) {
    return { error: `Unknown tool: ${name}` };
  }

  try {
    const built = tool.build(args ?? {}, options ?? {});
    console.log("[AI][Tool]", name, "->", built.summary);
    console.log("[AI][Tool] Arguments:", args);
    const execution = await runSupabaseSql(built.sql);

    return {
      ...built,
      execution,
    };
  } catch (err) {
    return { error: err.message || "Tool execution failed" };
  }
}

export async function getAICompletion(query, userContext = {}, extraOptions = {}) {
  if (!query) {
    throw new Error("Query is required for AI completion");
  }

  let options;
  let resolvedUserId;
  if (typeof userContext === "string") {
    resolvedUserId = userContext;
    options = { ...(extraOptions || {}), userId: resolvedUserId };
  } else {
    options = { ...(userContext || {}) };
    resolvedUserId = options.userId;
  }

  if (!options.userId && resolvedUserId) {
    options.userId = resolvedUserId;
  }

  console.log("RESOLEVED USERID:", resolvedUserId)

  const messages = [
    { role: "system", content: SCHEMA_REFERENCE },
    resolvedUserId
      ? {
          role: "system",
          content: `Use this Supabase user_id for all SQL queries: ${resolvedUserId}`,
        }
      : {
          role: "system",
          content:
            "If the precise user_id is unknown, ask for it or leave the argument empty so the backend can populate it.",
        },
    { role: "user", content: query },
  ];

  for (let iteration = 0; iteration < MAX_TOOL_CALL_ITERATIONS; iteration += 1) {
    console.log(`\n[AI] Iteration ${iteration + 1}/${MAX_TOOL_CALL_ITERATIONS}`);
    const response = await client.chat.completions.create({
      messages,
    model: "Qwen/Qwen3-VL-8B-Instruct",
      tools: TOGETHER_SQL_TOOLS,
      tool_choice: "auto",
    });

    const message = response.choices?.[0]?.message;
    if (!message) {
      break;
    }

    if (message.tool_calls?.length) {
      messages.push(message);

      for (const call of message.tool_calls) {
        console.log("[AI] Model requested tool:", call.function?.name);
        let parsedArgs = {};
        try {
          parsedArgs = call?.function?.arguments
            ? JSON.parse(call.function.arguments)
            : {};
        } catch (err) {
          parsedArgs = { error: "Invalid JSON arguments" };
        }

        if (options?.userId && !parsedArgs.userId) {
          parsedArgs.userId = options.userId;
        }

        const toolResult = await executeToolCall(
          call.function?.name,
          parsedArgs,
          options
        );

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(toolResult),
        });
      }
      continue;
    }

    messages.push(message);
    console.log("AI Response:", message.content);
    return message.content ?? "";
  }

  throw new Error("Unable to complete the request with available SQL tools");
}

if (process.argv[1] && process.argv[1].endsWith("ai.js")) {
  const SAMPLE_QUERY = `Give me a summary of today and list any students who still have not checked out.`;
  const SAMPLE_USER_ID = "d6c98450-6314-4401-bb25-13983bd315a9";

  (async () => {
    console.log("\n[AI] Running sample query:\n", SAMPLE_QUERY);
    try {
      const answer = await getAICompletion(SAMPLE_QUERY, SAMPLE_USER_ID);
      console.log("\n[AI] Final answer:\n", answer);
    } catch (err) {
      console.error("[AI] Sample query failed:", err);
    }
  })();
}