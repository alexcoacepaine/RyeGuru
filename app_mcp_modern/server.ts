import { createServer as createHttpServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT || 8787);
const ROOT = path.resolve(process.env.RYE_ROOT || path.join(import.meta.dirname, ".."));
const DB = path.join(ROOT, "retrieval", "rye.sqlite");
const UI = path.join(import.meta.dirname, "dist", "mcp-app.html");
const FORMULAS = path.join(ROOT, "formulas", "formula_groups.jsonl");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";
const MISSING = "Nu este documentat în sursele RYE disponibile.";
const RESOURCE_URI = "ui://rye/search/mcp-app.html";
const RESOURCE_MIME = "text/html;profile=mcp-app";

type EvidenceArgs = { source_id: string; page: number };
type FormulaArgs = { formula_id: string };
type CompareArgs = { topic: string; source_ids?: string[] };
type CalculateArgs = { formula_id: string; target_factor: number };
type ChatArgs = { question: string; history?: { role: "user" | "assistant"; content: string }[] };

type EvidenceRow = {
  evidence_id: string;
  source_id: string;
  page: number | null;
  pdf_page: number | null;
  text: string;
};

function db() {
  return new DatabaseSync(DB, { readOnly: true });
}

function searchRye(query: string, limit: number) {
  const con = db();
  try {
    const rows = con.prepare(`
      SELECT c.id AS evidence_id, c.source_id,
             c.printed_page AS page, c.pdf_page, c.text
      FROM chunks_fts f
      JOIN chunks c ON c.id = f.id
      WHERE chunks_fts MATCH ?
      LIMIT ?
    `).all(query, limit) as EvidenceRow[];
    return { query, results: rows };
  } finally { con.close(); }
}

function evidence(source_id: string, page: number) {
  const con = db();
  try {
    const rows = con.prepare(`
      SELECT id AS evidence_id, source_id,
             printed_page AS page, pdf_page, text
      FROM chunks
      WHERE source_id=? AND (printed_page=? OR pdf_page=?)
    `).all(source_id, page, page) as EvidenceRow[];
    return { source_id, page, results: rows };
  } finally { con.close(); }
}

async function formula(formula_id: string) {
  const lines = (await fs.readFile(FORMULAS, "utf8")).split("\n").filter(Boolean);
  for (const line of lines) {
    const x = JSON.parse(line);
    if (x.formula_id === formula_id) {
      return {
        formula_id,
        status: "needs_validation",
        source_id: x.source_id,
        page_ids: x.page_ids,
        title_candidate: x.title_candidate,
        raw_text: x.raw_text,
        note: "Această formulă este o candidată extrasă automat și nu este încă validată."
      };
    }
  }
  return { formula_id, status: "not_found", note: MISSING };
}

function buildContext(question: string) {
  const words = question
    .normalize("NFKC")
    .replace(/[“”„”"'?!,:;()[\]{}]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 3)
    .slice(0, 18);
  const fts = words.map(w => `"${w.replace(/"/g, "")}"`).join(" OR ") || `"${question.replace(/"/g, " ")}"`;
  const result = searchRye(fts, 16);
  return result.results;
}

function evidenceText(rows: EvidenceRow[]) {
  return rows.map((r, i) =>
    `[EVIDENCE ${i + 1}]\nsource_id: ${r.source_id}\nprinted_page: ${r.page ?? "—"}\npdf_page: ${r.pdf_page ?? "—"}\nevidence_id: ${r.evidence_id}\ntext:\n${r.text}`
  ).join("\n\n");
}

async function askRye(question: string, history: ChatArgs["history"] = []) {
  const rows = buildContext(question);
  if (!rows.length) {
    return { answer: MISSING, sources: [], model: OPENAI_MODEL };
  }
  if (!OPENAI_API_KEY) {
    return { answer: "Ask RyeGuru este pregătit, dar API-ul modelului nu este configurat încă.", sources: rows, model: OPENAI_MODEL, configuration_required: true };
  }

  const context = evidenceText(rows);
  const system = `Ești Ask RyeGuru, asistentul documentar pentru pâinea de secară.

REGULI OBLIGATORII:
- Folosește exclusiv informația din EVIDENCE furnizată mai jos.
- Nu completa golurile cu cunoștințe generale.
- Nu inventa rețete, ingrediente, cantități, procente, temperaturi, timpi sau proceduri.
- Dacă informația nu este susținută de EVIDENCE, spune exact: "${MISSING}"
- Dacă sursele diferă, prezintă diferențele separat și nu le reconcilia automat.
- Răspunde în română, clar și tehnic.
- Pentru fiecare afirmație factuală importantă, indică sursa între paranteze în forma [source_id, p. page].
- Nu cita o sursă care nu apare în EVIDENCE.
- Nu prezenta inferențe drept informații documentate.

EVIDENCE:
${context}`;

  const input = [
    ...history.slice(-6).map(m => ({ role: m.role, content: m.content })),
    { role: "user", content: question }
  ];

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: OPENAI_MODEL, reasoning: { effort: "medium" }, instructions: system, input, max_output_tokens: 1400 })
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("OpenAI error", response.status, detail);
    throw new Error(`model_request_failed:${response.status}`);
  }

  const data = await response.json() as any;
  const answer = data.output_text || data.output?.flatMap((x: any) => x.content || []).map((x: any) => x.text || "").join("") || MISSING;
  return {
    answer,
    sources: rows.map(r => ({ evidence_id: r.evidence_id, source_id: r.source_id, page: r.page, pdf_page: r.pdf_page, text: r.text })),
    model: OPENAI_MODEL
  };
}

const appToolMeta = { _meta: { ui: { resourceUri: RESOURCE_URI } } } as const;

function createServer() {
  const server = new McpServer({ name: "RYE Core", version: "0.1.0" });

  server.registerTool("search_rye", {
    title: "Caută în RYE",
    description: "Caută exclusiv în corpusul RYE și returnează dovezi cu sursă și pagină.",
    inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(20).optional() }),
    ...appToolMeta,
  }, async ({ query, limit = 8 }) => {
    const result = searchRye(query, limit);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  });

  server.registerTool("ask_ryeguru", {
    title: "Ask RyeGuru",
    description: "Răspunde exclusiv pe baza dovezilor recuperate din corpusul RYE.",
    inputSchema: z.object({ question: z.string().min(1), history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).max(6).optional() }),
  }, async ({ question, history }: ChatArgs) => {
    const result = await askRye(question, history);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  });

  server.registerTool("get_rye_evidence", {
    title: "Dovadă RYE",
    description: "Recuperează pasajele unei surse la o pagină exactă.",
    inputSchema: z.object({ source_id: z.string(), page: z.number().int().min(1) }),
  }, async ({ source_id, page }: EvidenceArgs) => {
    const result = evidence(source_id, page);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  });

  server.registerTool("get_formula", {
    title: "Formulă RYE",
    description: "Recuperează o formulă și păstrează explicit statutul de validare.",
    inputSchema: z.object({ formula_id: z.string() }),
  }, async ({ formula_id }: FormulaArgs) => {
    const result = await formula(formula_id);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  });

  server.registerTool("compare_sources", {
    title: "Compară surse RYE",
    description: "Compară rezultatele recuperate din mai multe surse fără reconciliere automată.",
    inputSchema: z.object({ topic: z.string().min(1), source_ids: z.array(z.string()).optional() }),
  }, async ({ topic, source_ids }: CompareArgs) => {
    const base = searchRye(topic, 20);
    const filtered = source_ids?.length ? base.results.filter((r) => source_ids.includes(r.source_id)) : base.results;
    const result = { topic, source_ids: source_ids ?? null, results: filtered, rule: "Claims remain source-separated." };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  });

  server.registerTool("calculate_formula", {
    title: "Scalează formulă RYE",
    description: "Scaling mecanic. Formulele nevalidate sunt refuzate.",
    inputSchema: z.object({ formula_id: z.string(), target_factor: z.number().positive() }),
  }, async ({ formula_id }: CalculateArgs) => {
    const result = { formula_id, status: "blocked", reason: "formula_not_validated", message: "Scaling-ul este permis numai după validarea formulei în RYE Core." };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  });

  server.registerResource("rye-search-ui", RESOURCE_URI, {
    title: "RYE Search UI",
    description: "Interfața RYE pentru rezultate de căutare.",
    mimeType: RESOURCE_MIME,
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: RESOURCE_MIME, text: await fs.readFile(UI, "utf8") }] }));

  return server;
}

const http = createHttpServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, service: "ryeguru-mcp", model: OPENAI_MODEL, chat_configured: Boolean(OPENAI_API_KEY) }));
    return;
  }

  if (req.url === "/chat" && req.method === "POST") {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      const question = String(parsed.question || "").trim();
      if (!question) { res.writeHead(400, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ error: "question_required" })); return; }
      const result = await askRye(question, parsed.history);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error(err);
      res.writeHead(500, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ error: "chat_failed" }));
    }
    return;
  }

  if (req.url === "/mcp") {
    try {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "mcp_request_failed" }));
      console.error(err);
    }
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("RYE MCP");
});

http.listen(PORT, () => console.log(`RYE MCP listening on port ${PORT}`));
