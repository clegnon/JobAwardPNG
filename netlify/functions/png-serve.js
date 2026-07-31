// GET /api/png?tableId=&recordId=&fieldId=&exp=&sig=
// Public URL for Outlook attachments. Fetches the QB file server-side after
// verifying a short-lived HMAC signature (no auth headers required from Outlook).

import { createHmac, timingSafeEqual } from "crypto";

const QB_REALM = process.env.QB_REALM;
const QB_TOKEN = process.env.QB_USER_TOKEN;
const SECRET = process.env.SHARED_SECRET;

const qbHeaders = {
  "QB-Realm-Hostname": QB_REALM,
  Authorization: `QB-USER-TOKEN ${QB_TOKEN}`,
  "Content-Type": "application/json",
};

function sign(payload) {
  return createHmac("sha256", SECRET).update(payload).digest("hex");
}

function safeEqualHex(a, b) {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export default async (req) => {
  try {
    if (req.method !== "GET") {
      return json({ error: "GET only" }, 405);
    }

    const url = new URL(req.url);
    const tableId = url.searchParams.get("tableId");
    const recordId = url.searchParams.get("recordId");
    const fieldId = url.searchParams.get("fieldId");
    const exp = url.searchParams.get("exp");
    const sig = url.searchParams.get("sig");

    if (!tableId || !recordId || !fieldId || !exp || !sig) {
      return json({ error: "tableId, recordId, fieldId, exp, sig are required" }, 400);
    }

    const now = Math.floor(Date.now() / 1000);
    if (Number(exp) < now) {
      return json({ error: "URL expired" }, 403);
    }

    const payload = `${tableId}.${recordId}.${fieldId}.${exp}`;
    if (!safeEqualHex(sign(payload), sig)) {
      return json({ error: "Invalid signature" }, 403);
    }

    const queryRes = await fetch("https://api.quickbase.com/v1/records/query", {
      method: "POST",
      headers: qbHeaders,
      body: JSON.stringify({
        from: tableId,
        select: [Number(fieldId)],
        where: `{3.EX.'${recordId}'}`,
      }),
    });
    if (!queryRes.ok) return json({ error: "QB query failed", detail: await queryRes.text() }, 502);

    const queryData = await queryRes.json();
    const fileVal = queryData.data?.[0]?.[fieldId]?.value;
    if (!fileVal?.url) return json({ error: "No file found" }, 404);

    const fileRes = await fetch(`https://api.quickbase.com/v1${fileVal.url}`, {
      headers: qbHeaders,
    });
    if (!fileRes.ok) return json({ error: "QB file download failed", detail: await fileRes.text() }, 502);

    const fileName =
      fileVal.versions?.at(-1)?.fileName || `record-${recordId}.png`;
    const bytes = Buffer.from(await fileRes.text(), "base64");

    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (err) {
    console.error(err);
    return json({ error: err.message }, 500);
  }
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const config = { path: "/api/png" };
