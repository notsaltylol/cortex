import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";

// POST /api/keelson-email  body: { emails: [{ id, text }] }  (max 30, text capped at 2000 chars)
// Response: { results: [{ id, kind, label, confidence, urgent }] }
//   kind: "status" | "expedite" | "order" | "quality" | "other" (null if TypeSafe gave no answer)
//   urgent: probability (0..1) that the email needs a reply today (upset customer, line-down risk
//   or a same-day deadline). The page combines this with its own rules and flags any disagreement.

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const MAX_EMAILS = 30;
const MAX_TEXT = 2000;

const KINDS = {
  "Order status / where is my order": "status",
  "Expedite or date change request": "expedite",
  "New order, reorder or quote request": "order",
  "Quality, shortage or damage issue": "quality",
  "Other": "other",
};

export async function handleKeelsonEmail(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (!env.TYPESAFE_API_KEY) return json({ error: "TYPESAFE_API_KEY not configured" }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const emails = (Array.isArray(body?.emails) ? body.emails : [])
    .map((e) => ({ id: String(e?.id ?? "").trim().slice(0, 60), text: String(e?.text ?? "").trim().slice(0, MAX_TEXT) }))
    .filter((e) => e.text)
    .slice(0, MAX_EMAILS);
  if (!emails.length) return json({ error: "emails required" }, 400);

  try {
    const client = new TypeSafeClient({ apiKey: env.TYPESAFE_API_KEY });
    const state = {
      context:
        "Keelson Fastening Systems manufactures industrial fasteners and fittings in Rockford, Illinois. " +
        "It sells to equipment makers (OEMs) under direct contracts and through industrial distributors. " +
        "Each email below was sent to Keelson's inside-sales desk by one of those customers, an OEM or a distributor. " +
        "'Line down' means the customer's production line has stopped, or is about to, for lack of parts.",
    };
    const questions = {};
    emails.forEach((e, i) => {
      state[`e${i}`] = e.text;
      questions[`k${i}`] = choice(
        `\`e${i}\` is an email from an OEM or distributor customer to a fastener manufacturer's inside-sales desk. What is the customer mainly asking for? ` +
          "Asking where an order is, its ship date, ETA or tracking is order status. " +
          "Asking to ship sooner, pull in, push out or change a required date is an expedite or date change request. " +
          "Sending a PO, asking to reorder, or asking for a quote or price is a new order, reorder or quote request. " +
          "Reporting damaged, short, missing, wrong or out-of-spec parts is a quality, shortage or damage issue.",
        Object.fromEntries(Object.keys(KINDS).map((k) => [k, null])),
      );
      questions[`u${i}`] = noul(
        `Does \`e${i}\` need a reply today: is the customer upset, does it mention a line-down or production-stopping risk, or does it state a same-day deadline?`,
      );
    });
    const { answers } = await client.systemOne({ state, questions });
    return json({
      results: emails.map((e, i) => {
        const k = answers?.[`k${i}`];
        const u = answers?.[`u${i}`];
        return {
          id: e.id,
          kind: KINDS[k?.choice] ?? null,
          label: k?.choice ?? null,
          confidence: typeof k?.confidence === "number" ? k.confidence : null,
          urgent: typeof u?.noul === "number" ? u.noul : null,
        };
      }),
    });
  } catch (e) {
    return json({ error: "TypeSafe request failed" }, 502);
  }
}
