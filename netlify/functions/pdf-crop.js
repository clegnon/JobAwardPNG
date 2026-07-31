// netlify/functions/pdf-crop.js
// Triggered by a Quickbase Pipeline. Downloads a PDF attachment, renders
// page 1 to PNG, trims blank margins, and uploads the PNG back to the record.
//
// Env vars required (Netlify site settings):
//   QB_REALM        e.g. coopersteel.quickbase.com
//   QB_USER_TOKEN   Quickbase user token
//   SHARED_SECRET   arbitrary string; must match the header sent by the Pipeline

import { pdfToPng } from "pdf-to-png-converter";
import sharp from "sharp";

const QB_REALM = process.env.QB_REALM;
const QB_TOKEN = process.env.QB_USER_TOKEN;
const SECRET = process.env.SHARED_SECRET;

const qbHeaders = {
  "QB-Realm-Hostname": QB_REALM,
  Authorization: `QB-USER-TOKEN ${QB_TOKEN}`,
  "Content-Type": "application/json",
};

export default async (req) => {
  try {
    if (req.method !== "POST") {
      return json({ error: "POST only" }, 405);
    }
    if (req.headers.get("x-shared-secret") !== SECRET) {
      return json({ error: "Unauthorized" }, 401);
    }

    const { tableId, recordId, pdfFieldId, pngFieldId, dpi = 200, trimThreshold = 25 } =
      await req.json();

    if (!tableId || !recordId || !pdfFieldId || !pngFieldId) {
      return json({ error: "tableId, recordId, pdfFieldId, pngFieldId are required" }, 400);
    }

    const queryRes = await fetch("https://api.quickbase.com/v1/records/query", {
      method: "POST",
      headers: qbHeaders,
      body: JSON.stringify({
        from: tableId,
        select: [Number(pdfFieldId)],
        where: `{3.EX.'${recordId}'}`,
      }),
    });
    if (!queryRes.ok) return json({ error: "QB query failed", detail: await queryRes.text() }, 502);

    const queryData = await queryRes.json();
    const fileVal = queryData.data?.[0]?.[pdfFieldId]?.value;
    if (!fileVal?.url) return json({ error: "No file found in PDF field" }, 404);

    const fileRes = await fetch(`https://api.quickbase.com/v1${fileVal.url}`, {
      headers: qbHeaders,
    });
    if (!fileRes.ok) return json({ error: "QB file download failed", detail: await fileRes.text() }, 502);

    const pdfBuffer = Buffer.from(await fileRes.text(), "base64");

    const pages = await pdfToPng(pdfBuffer, {
      pagesToProcess: [1],
      viewportScale: dpi / 72,
    });
    if (!pages.length) return json({ error: "PDF rendered no pages" }, 422);

    const trimmed = await sharp(pages[0].content)
      .flatten({ background: "#ffffff" })
      .trim({ background: "#ffffff", threshold: trimThreshold })
      .png()
      .toBuffer();

    const baseName = (fileVal.versions?.at(-1)?.fileName || "document.pdf").replace(/\.pdf$/i, "");
    const uploadRes = await fetch("https://api.quickbase.com/v1/records", {
      method: "POST",
      headers: qbHeaders,
      body: JSON.stringify({
        to: tableId,
        data: [
          {
            3: { value: Number(recordId) },
            [pngFieldId]: {
              value: {
                fileName: `${baseName}_cropped.png`,
                data: trimmed.toString("base64"),
              },
            },
          },
        ],
      }),
    });
    if (!uploadRes.ok) return json({ error: "QB upload failed", detail: await uploadRes.text() }, 502);

    return json({
      ok: true,
      recordId,
      output: `${baseName}_cropped.png`,
      bytes: trimmed.length,
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

export const config = { path: "/api/pdf-crop" };
