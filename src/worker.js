import { handlePlaid } from "./plaid.js";
import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/plaid/")) return handlePlaid(request, env, url.pathname);
    if (url.pathname === "/api/score") return score(request, env);
    if (url.pathname === "/api/classify-stock") return classifyStock(request, env);
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
