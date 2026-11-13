import { handlePlaid } from "./plaid.js";
import { handleTicketRisk } from "./ticketrisk.js";
import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/plaid/")) return handlePlaid(request, env, url.pathname);
    if (url.pathname === "/api/score") return score(request, env);
    if (url.pathname === "/api/classify-stock") return classifyStock(request, env);
    if (url.pathname === "/api/ro-auth") return roAuth(request, env);
    if (url.pathname === "/api/elimu-intake") return elimuIntake(request, env);
    if (url.pathname === "/api/ticket-risk") return handleTicketRisk(request, env);
    if (url.pathname !== "/api/categorize") return env.ASSETS.fetch(request);
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (!env.TYPESAFE_API_KEY) return json({ error: "TYPESAFE_API_KEY not configured" }, 503);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
    const description = String(body.description ?? "").trim().slice(0, 200);
    const categories = (Array.isArray(body.categories) ? body.categories : [])
      .map((c) => String(c).trim().slice(0, 40)).filter(Boolean).slice(0, 30);
    const recent = (Array.isArray(body.recent) ? body.recent : [])
      .map((d) => String(d).slice(0, 120)).slice(0, 20);
    if (!description) return json({ error: "description required" }, 400);

    try {
      const client = new TypeSafeClient({ apiKey: env.TYPESAFE_API_KEY });
      const questions = {
        duplicate: noul(
          "Does the new expense describe the same purchase as any entry in recentExpenses (likely an accidental double entry)?",
        ),
      };
      if (categories.length) {
        questions.category = choice(
          "Which category best fits the new expense?",
          { ...Object.fromEntries(categories.map((c) => [c, null])), "(none of these)": null },
        );
      }
      const { answers } = await client.systemOne({
        state: { newExpense: description, recentExpenses: recent },
        questions,
      });
      const picked = answers.category?.choice;
      return json({
        category: picked && picked !== "(none of these)" ? picked : null,
        duplicate: answers.duplicate.noul,
      });
    } catch (e) {
      return json({ error: "TypeSafe request failed" }, 502);
    }
  },
};

const LEVELS = {
  green: "Healthy: engaged usage, few or no problems, renewal very likely.",
  amber: "Watch: some warning signs (declining usage, open issues or near renewal) but recoverable.",
  red: "At risk: strong churn signals such as sharp usage decline, escalated tickets, or imminent renewal with disengagement.",
};

async function score(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (!env.TYPESAFE_API_KEY) return json({ error: "TYPESAFE_API_KEY not configured" }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const accounts = (Array.isArray(body.accounts) ? body.accounts : []).slice(0, 40);
  if (!accounts.length) return json({ error: "accounts required" }, 400);
  try {
    const client = new TypeSafeClient({ apiKey: env.TYPESAFE_API_KEY });
    const questions = {};
    const state = {};
    accounts.forEach((a, i) => {
      state[`a${i}`] = {
        plan: String(a.plan ?? "").slice(0, 40),
        usageChange30dPercent: Number(a.usageChange),
        activeSeatsPercent: Number(a.activeSeats),
        openTickets: Number(a.openTickets),
        hasEscalatedTicket: !!a.escalated,
        daysToRenewal: Number(a.daysToRenewal),
      };
      questions[`a${i}`] = choice(
        `Based on \`${`a${i}`}\`, what is this subscription account's churn risk at renewal?`,
        LEVELS,
      );
    });
    const { answers } = await client.systemOne({ state, questions });
    return json({
      scores: accounts.map((a, i) => ({ id: a.id, rag: answers[`a${i}`].choice })),
    });
  } catch (e) {
    return json({ error: "TypeSafe request failed" }, 502);
  }
}

const DEPARTMENTS = [
  "Apparel", "Footwear", "Electronics", "Home and kitchen", "Furniture", "Toys and games", "Grocery and food",
  "Health and beauty", "Sports and outdoors", "Seasonal and holiday", "Automotive and hardware", "Books and media", "Other",
];

async function classifyStock(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (!env.TYPESAFE_API_KEY) return json({ error: "TYPESAFE_API_KEY not configured" }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const lines = (Array.isArray(body.lines) ? body.lines : []).map((l) => String(l).trim().slice(0, 300)).filter(Boolean).slice(0, 20);
  if (!lines.length) return json({ error: "lines required" }, 400);
  try {
    const client = new TypeSafeClient({ apiKey: env.TYPESAFE_API_KEY });
    const state = {}, questions = {};
    lines.forEach((l, i) => {
      state[`l${i}`] = l;
      questions[`c${i}`] = choice(
        `What kind of retail product is described in \`l${i}\`? Pick the department it would be stocked under.`,
        Object.fromEntries(DEPARTMENTS.map((d) => [d, null])),
      );
      questions[`k${i}`] = choice(
        `What is \`l${i}\` mostly about?`,
        { "Stock line": null, "Invoice or payment": null, "Other": null },
      );
      questions[`d${i}`] = choice(
        `If \`l${i}\` is about an invoice or payment, who owes whom?`,
        { "We owe it": null, "Owed to us": null, "Unclear": null },
      );
      questions[`s${i}`] = noul(
        `Is the product described in \`l${i}\` one whose sales are driven by a season, holiday, weather or event, so that demand is concentrated in a peak period?`,
      );
    });
    const { answers } = await client.systemOne({ state, questions });
    return json({ results: lines.map((_, i) => ({ category: answers[`c${i}`].choice, seasonal: answers[`s${i}`].noul, kind: answers[`k${i}`].choice, direction: answers[`d${i}`].choice })) });
  } catch (e) {
    return json({ error: "TypeSafe request failed" }, 502);
  }
}

// RO approval check (Maumee Valley Auto Care). One choice per RO note; the page combines this
// with its own rules and holds the RO whenever the two disagree.
const RO_AUTH = {
  written: "Written approval is recorded for the whole job: the customer signed or e-signed the estimate or repair authorization, or approved by text or email and that reply was saved.",
  verbal: "Only spoken approval: the customer said yes, OK'd or approved it on the phone, by voicemail or in person, and nothing was signed or saved in writing.",
  none: "No approval recorded yet: the estimate may have been sent or the customer contacted, but they have not approved, or signing is planned for later such as at pickup.",
  declined: "The customer declined or refused the work.",
  partial: "Written approval covers only part of the work; another part was approved only verbally, declined, or not approved.",
};

async function roAuth(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (!env.TYPESAFE_API_KEY) return json({ error: "TYPESAFE_API_KEY not configured" }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  if (!body || !Array.isArray(body.notes)) return json({ error: "notes must be an array of strings" }, 400);
  if (body.notes.length > 30) return json({ error: "At most 30 notes per request" }, 400);
  const notes = body.notes.map((n) => (typeof n === "string" ? n.trim().slice(0, 400) : ""));
  if (!notes.length) return json({ error: "notes required" }, 400);
  const empty = notes.findIndex((n) => !n);
  if (empty !== -1) return json({ error: `note ${empty + 1} is empty or not text` }, 400);
  try {
    const client = new TypeSafeClient({ apiKey: env.TYPESAFE_API_KEY });
    const state = {}, questions = {};
    notes.forEach((n, i) => {
      state[`n${i}`] = n;
      questions[`a${i}`] = choice(
        `\`n${i}\` is a repair-order note written by a service writer at an auto-repair shop. What customer approval for the estimated repair work does the note record, before the technician starts?`,
        RO_AUTH,
      );
    });
    const { answers } = await client.systemOne({ state, questions });
    return json({
      results: notes.map((_, i) => {
        const a = answers[`a${i}`];
        return a ? { choice: a.choice, confidence: a.confidence } : null;
      }),
    });
  } catch (e) {
    return json({ error: "TypeSafe request failed" }, 502);
  }
}

// Elimu Plus intake: classify pasted notes (payments, overdue invoices, complaints, absences)
// so centre managers get a next step even before a student list is loaded.
const ELIMU_KINDS = {
  payment: "A parent has paid or sent money: an M-Pesa, bank or cash payment confirmation or receipt for fees.",
  overdue: "A fee or invoice is unpaid, overdue or a balance is outstanding, or a parent promises to pay later.",
  complaint: "A parent raises a complaint, concern or dissatisfaction about teaching, a tutor, the centre, fees or their child's progress.",
  absence: "A student has been absent, stopped attending, is leaving, or the family is withdrawing or pausing.",
  other: "None of the above, such as a general question, schedule change or unrelated message.",
};

async function elimuIntake(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (!env.TYPESAFE_API_KEY) return json({ error: "TYPESAFE_API_KEY not configured" }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  if (!body || !Array.isArray(body.notes)) return json({ error: "notes must be an array of strings" }, 400);
  const notes = body.notes.map((n) => (typeof n === "string" ? n.trim().slice(0, 500) : "")).filter(Boolean).slice(0, 30);
  if (!notes.length) return json({ error: "notes required" }, 400);
  try {
    const client = new TypeSafeClient({ apiKey: env.TYPESAFE_API_KEY });
    const state = {}, questions = {};
    notes.forEach((n, i) => {
      state[`n${i}`] = n;
      questions[`k${i}`] = choice(
        `\`n${i}\` is a note pasted by a manager at a tutoring centre (it may be an SMS, M-Pesa message, invoice line or a parent's message). What is it mainly about?`,
        ELIMU_KINDS,
      );
      questions[`u${i}`] = noul(
        `Does \`n${i}\` indicate the parent is upset, threatening to leave, or that the matter needs a reply today?`,
      );
    });
    const { answers } = await client.systemOne({ state, questions });
    return json({
      results: notes.map((_, i) => ({
        kind: answers[`k${i}`]?.choice ?? null,
        confidence: answers[`k${i}`]?.confidence ?? null,
        urgent: answers[`u${i}`]?.noul ?? null,
      })),
    });
  } catch (e) {
    return json({ error: "TypeSafe request failed" }, 502);
  }
}
