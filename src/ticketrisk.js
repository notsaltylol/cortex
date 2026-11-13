import { choice, TypeSafeClient } from "@typesafe-ai/sdk";

// POST /api/ticket-risk  body: { tickets: [{ id, text }] }  (max 30, text capped at 1500 chars)
// Response: { results: [{ id, verdict: "risk"|"watch"|"normal", label, confidence }] }

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const MAX_TICKETS = 30;
const MAX_TEXT = 1500;

const OPTIONS = {
  "Account at risk of cancelling or not renewing": "risk",
  "Frustrated but no cancellation intent": "watch",
  "Routine support (including cancelling jobs, appointments, dispatches or invoices)": "normal",
};

export async function handleTicketRisk(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (!env.TYPESAFE_API_KEY) return json({ error: "TYPESAFE_API_KEY not configured" }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const tickets = (Array.isArray(body?.tickets) ? body.tickets : [])
    .map((t) => ({ id: String(t?.id ?? "").trim().slice(0, 60), text: String(t?.text ?? "").trim().slice(0, MAX_TEXT) }))
    .filter((t) => t.text)
    .slice(0, MAX_TICKETS);
  if (!tickets.length) return json({ error: "tickets required" }, 400);

  try {
    const client = new TypeSafeClient({ apiKey: env.TYPESAFE_API_KEY });
    const state = {
      context:
        "Brasswire Software sells a subscription SaaS product for scheduling, dispatch and invoicing to HVAC, plumbing and electrical contractors. " +
        "Its customers routinely cancel their own jobs, appointments, dispatches, work orders and invoices inside the product; that is normal product use, not a sign the customer is leaving Brasswire.",
    };
    const questions = {};
    tickets.forEach((t, i) => {
      state[`t${i}`] = t.text;
      questions[`t${i}`] = choice(
        `\`t${i}\` is a support ticket written by a Brasswire customer company. Does the customer state or threaten that they will cancel, not renew, terminate, downgrade or leave their Brasswire subscription or contract (including switching to a competitor or escalating to executives or legal)? A request about cancelling a job, appointment, dispatch, work order or invoice is routine. A statement that they are NOT planning to cancel is not cancellation intent.`,
        Object.fromEntries(Object.keys(OPTIONS).map((k) => [k, null])),
      );
    });
    const { answers } = await client.systemOne({ state, questions });
    return json({
      results: tickets.map((t, i) => {
        const a = answers[`t${i}`];
        return { id: t.id, verdict: OPTIONS[a?.choice] ?? null, label: a?.choice ?? null, confidence: a?.confidence ?? null };
      }),
    });
  } catch (e) {
    return json({ error: "TypeSafe request failed" }, 502);
  }
}
