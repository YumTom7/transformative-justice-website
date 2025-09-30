import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const OPENAI_API = "https://api.openai.com/v1";

function dataURLtoBuffer(dataUrl) {
  const [meta, b64] = dataUrl.split(",");
  const mime = (meta.match(/^data:(.*?);base64$/) || [,"application/octet-stream"])[1];
  return { buffer: Buffer.from(b64, "base64"), mime };
}

function renderHTML({ jobId, flags, emerging_terms }) {
  const rows = (flags || []).map(f => `
    <tr>
      <td>${f.id}</td>
      <td>${f.span}</td>
      <td>${f.reasons.join(", ")}</td>
      <td>${f.flag_score.toFixed(2)}</td>
      <td>${f.redaction}</td>
      <td><pre style="background:#fff7d6;padding:8px;border-radius:8px;white-space:pre-wrap">${f.snippet || ""}</pre></td>
    </tr>`).join("");
  const terms = (emerging_terms || []).map(t => `<li>${t.surface} — ${t.status} (${t.count})</li>`).join("");
  return `<!doctype html><meta charset="utf-8"><title>CaseConnect Report ${jobId}</title>
  <style>body{font:14px system-ui;background:#fafafa;color:#111;padding:24px}
  table{width:100%;border-collapse:separate;border-spacing:0;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden}
  th,td{padding:10px;border-bottom:1px solid #eee;text-align:left} th{background:#f6f8fb;font-size:12px;text-transform:uppercase}</style>
  <h1>CaseConnect — Investigator Report</h1>
  <p>Contains short verbatim excerpts; treat as discoverable.</p>
  <p><b>Job:</b> ${jobId}</p>
  <h2>Flags</h2>
  <table><thead><tr><th>#</th><th>Span</th><th>Reasons</th><th>Score</th><th>Redaction</th><th>Snippet</th></tr></thead>
  <tbody>${rows || "<tr><td colspan='6'>No flags</td></tr>"}</tbody></table>
  <h2>Emerging Terms</h2><ul>${terms || "<li>None</li>"}</ul>`;
}

async function transcribe({ buffer, mime, filename }) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mime }), filename);
  form.append("model", "whisper-1"); // or "gpt-4o-mini-transcribe" if enabled on your key
  const r = await fetch(`${OPENAI_API}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || r.statusText);
  return j.text || "";
}

async function triage({ transcript }) {
  const schema = {
    type: "object",
    properties: {
      schema_version: { type: "string" },
      flags: { type: "array", items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          span: { type: "string" },
          reasons: { type: "array", items: { type: "string" } },
          flag_score: { type: "number" },
          redaction: { type: "string" },
          snippet: { type: "string" }
        }, required: ["id","span","reasons","flag_score","redaction"]
      }},
      emerging_terms: { type: "array", items: {
        type: "object",
        properties: { surface:{type:"string"}, count:{type:"integer"}, status:{type:"string"} },
        required: ["surface","count","status"]
      }}
    },
    required: ["schema_version","flags","emerging_terms"]
  };

  const body = {
    model: "gpt-4o-mini",
    response_format: { type: "json_schema", json_schema: { name: "triage_v1_1", schema, strict: true } },
    input: [
      { role: "system", content: "You are a jail-call triage agent. Output structured JSON only. Neutral tone. Use short verbatim snippets (<=280 chars)."},
      { role: "user", content: `Transcript:\n${transcript}\n\nGenerate low-signal triage with a few example flags if relevant.`}
    ]
  };

  const r = await fetch(`${OPENAI_API}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || r.statusText);

  // Structured Outputs path
  const out = j.output?.[0]?.content?.[0];
  const data = out?.json ?? (out?.text ? JSON.parse(out.text) : null);
  if (!data) throw new Error("No structured JSON returned");
  return data;
}

export default async (req) => {
  try {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const { filename = "audio.wav", dataUrl } = await req.json();
    if (!dataUrl) return new Response(JSON.stringify({ error: "Missing dataUrl" }), { status: 400 });

    const { buffer, mime } = dataURLtoBuffer(dataUrl);
    const jobId = crypto.randomUUID();

    const transcript = await transcribe({ buffer, mime, filename });
    const summary = await triage({ transcript });
    const html = renderHTML({ jobId, flags: summary.flags || [], emerging_terms: summary.emerging_terms || [] });

    const store = getStore({ name: "caseconnect" });
    await store.setJSON(`summaries/${jobId}.json`, { job_id: jobId, ...summary });
    await store.set(`reports/${jobId}.html`, html, { metadata: { "content-type": "text/html; charset=utf-8" } });

    const base = "/.netlify/functions/artifacts";
    return Response.json({
      job_id: jobId,
      report_url: `${base}?key=${encodeURIComponent(`reports/${jobId}.html`)}`,
      summary_url: `${base}?key=${encodeURIComponent(`summaries/${jobId}.json`)}`
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "content-type": "application/json" }});
  }
};

