import { createServer as createHttpServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";

const PORT = Number(process.env.PORT || 8787);
const ROOT = path.resolve(process.env.RYE_ROOT || path.join(import.meta.dirname, ".."));
const DB = path.join(ROOT, "retrieval", "rye.sqlite");
const UI = path.join(import.meta.dirname, "dist", "mcp-app.html");
const FORMULAS = path.join(ROOT, "formulas", "formula_groups.jsonl");
const MISSING = "Nu este documentat în sursele RYE disponibile.";
const RESOURCE_URI = "ui://rye/search/mcp-app.html";

function db() { return new Database(DB, { readonly: true }); }

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
    `).all(query, limit);
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
    `).all(source_id, page, page);
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

function createServer() {
  const server = new McpServer({ name: "RYE Core", version: "0.1.0" });

  registerAppTool(server, "search_rye", {
    title: "Caută în RYE",
    description: "Caută exclusiv în corpusul RYE și returnează dovezi cu sursă și pagină.",
    inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(20).optional() },
    _meta: { ui: { resourceUri: RESOURCE_URI } },
  }, async ({ query, limit = 8 }) => {
    const result = searchRye(query, limit);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  });

  registerAppTool(server, "get_rye_evidence", {
    title: "Dovadă RYE",
    description: "Recuperează pasajele unei surse la o pagină exactă.",
    inputSchema: { source_id: z.string(), page: z.number().int().min(1) },
  }, async ({ source_id, page }) => {
    const result = evidence(source_id, page);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  });

  registerAppTool(server, "get_formula", {
    title: "Formulă RYE",
    description: "Recuperează o formulă și păstrează explicit statutul de validare.",
    inputSchema: { formula_id: z.string() },
  }, async ({ formula_id }) => {
    const result = await formula(formula_id);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  });

  registerAppTool(server, "compare_sources", {
    title: "Compară surse RYE",
    description: "Compară rezultatele recuperate din mai multe surse fără reconciliere automată.",
    inputSchema: { topic: z.string().min(1), source_ids: z.array(z.string()).optional() },
  }, async ({ topic, source_ids }) => {
    const base = searchRye(topic, 20);
    const filtered = source_ids?.length ? base.results.filter((r: any) => source_ids.includes(r.source_id)) : base.results;
    const result = { topic, source_ids: source_ids ?? null, results: filtered, rule: "Claims remain source-separated." };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  });

  registerAppTool(server, "calculate_formula", {
    title: "Scalează formulă RYE",
    description: "Scaling mecanic. Formulele nevalidate sunt refuzate.",
    inputSchema: { formula_id: z.string(), target_factor: z.number().positive() },
  }, async ({ formula_id }) => {
    const result = { formula_id, status: "blocked", reason: "formula_not_validated", message: "Scaling-ul este permis numai după validarea formulei în RYE Core." };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  });

  registerAppResource(server, RESOURCE_URI, "RYE Search UI", { mimeType: RESOURCE_MIME_TYPE }, async () => ({
    contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: await fs.readFile(UI, "utf8") }]
  }));

  return server;
}

const http = createHttpServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, service: "ryeguru-mcp" }));
    return;
  }
  if (req.url !== "/mcp") {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("RYE MCP");
    return;
  }
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
});

http.listen(PORT, () => console.log(`RYE MCP listening on port ${PORT}`));
