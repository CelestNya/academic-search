#!/usr/bin/env node
/**
 * ars — academic search CLI (zero dependencies)
 *
 * Talks to public scholarly APIs over plain HTTPS. No MCP, no JSON-RPC,
 * no daemon, no install step beyond having Node. Ports across machines by
 * copying one directory.
 *
 * Sources: arxiv | crossref | pubmed | s2 (Semantic Scholar)
 * OpenAlex is reachable but not a search source here: it bills per request
 * ($0.001) and the free daily credit is spent by shared-proxy traffic.
 *
 * NOTE ON PROXIES: this CLI uses Node's core https module, which does NOT
 * read http_proxy/https_proxy. Requests therefore go out directly. That is
 * intentional and load-bearing — OpenAlex rejects the local proxy's shared
 * exit IP with HTTP 403 "Insufficient budget" while the same request from
 * this machine's real IP succeeds. Do not "fix" this by adding proxy
 * support; it would break sources that rate-limit on shared IPs.
 */
"use strict";

const https = require("https");
const zlib = require("zlib");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { URL } = require("url");

const UA = "ars-cli/1.0 (+academic search; node)";
const TIMEOUT_MS = 30000;

// ---------------------------------------------------------------- credentials
//
// Resolution order, highest wins:
//   1. CLI flag        --s2-key <k>   --pubmed-key <k>   --mailto <email>
//   2. Environment     ARS_S2_API_KEY  ARS_PUBMED_API_KEY  ARS_MAILTO
//   3. Config file     ~/.config/ars/config.json  (or $ARS_CONFIG)
//   4. Anonymous       all four sources work this way, with lower limits
//
// Every credential is optional. The config file lives outside the skill
// directory on purpose: the skill is meant to be copied between machines and
// agent tools, and a key must not travel with it.

const CONFIG_PATHS = [
  process.env.ARS_CONFIG,
  path.join(os.homedir(), ".config", "ars", "config.json"),
  path.join(os.homedir(), ".arsrc.json"),
].filter(Boolean);

function loadConfig() {
  for (const p of CONFIG_PATHS) {
    let raw;
    try {
      raw = fs.readFileSync(p, "utf8");
    } catch {
      continue; // not present at this location; try the next
    }
    try {
      const j = JSON.parse(raw);
      return { file: p, data: j && typeof j === "object" ? j : {} };
    } catch (e) {
      // A malformed config must not abort a search; warn and keep going.
      process.stderr.write(`warning: ignoring malformed config ${p}: ${e.message}\n`);
      return { file: p, data: {} };
    }
  }
  return { file: null, data: {} };
}

const CONFIG = loadConfig();

// Filled in by parseArgs so flags can outrank env/config.
let CLI_CREDS = {};

const ENV_NAMES = {
  s2: "ARS_S2_API_KEY",
  pubmed: "ARS_PUBMED_API_KEY",
  openalex: "ARS_OPENALEX_API_KEY",
  mailto: "ARS_MAILTO",
};

function cred(name) {
  if (CLI_CREDS[name]) return CLI_CREDS[name];
  const env = ENV_NAMES[name];
  if (env && process.env[env]) return process.env[env];
  const d = CONFIG.data;
  if (d[name]) return d[name];
  if (d.keys && d.keys[name]) return d.keys[name];
  return null;
}

// Where a credential came from, for `ars keys` reporting.
function credSource(name) {
  if (CLI_CREDS[name]) return "flag";
  const env = ENV_NAMES[name];
  if (env && process.env[env]) return `env:${env}`;
  const d = CONFIG.data;
  if (d[name] || (d.keys && d.keys[name])) return `file:${CONFIG.file}`;
  return null;
}

// ---------------------------------------------------------------- transport

function request(url, { accept, headers } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          "User-Agent": UA,
          Accept: accept || "application/json",
          "Accept-Encoding": "gzip, deflate",
          ...(headers || {}),
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(request(new URL(res.headers.location, url).toString(), { accept, headers }));
        }
        const enc = (res.headers["content-encoding"] || "").toLowerCase();
        let stream = res;
        if (enc === "gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());

        const chunks = [];
        stream.on("data", (c) => chunks.push(c));
        stream.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode >= 400) {
            const err = new Error(`HTTP ${res.statusCode}`);
            err.status = res.statusCode;
            err.body = body.slice(0, 300);
            return reject(err);
          }
          resolve(body);
        });
        stream.on("error", reject);
      }
    );
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

async function getJson(url, accept, headers) {
  return JSON.parse(await request(url, { accept, headers }));
}

// ---------------------------------------------------------------- utilities

const stripTags = (s) =>
  String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const yearOf = (v) => {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const m = String(v).match(/\d{4}/);
  return m ? Number(m[0]) : null;
};

function authorsOf(list, max = 4) {
  if (!Array.isArray(list) || !list.length) return [];
  const names = list
    .map((a) => (typeof a === "string" ? a : a?.name || a?.family || null))
    .filter(Boolean);
  if (names.length <= max) return names;
  return [...names.slice(0, max), `+${names.length - max} more`];
}

function xmlBlocks(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`, "g");
  let m;
  while ((m = re.exec(xml))) out.push(m[0]);
  return out;
}

const xmlText = (block, tag) => {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? stripTags(m[1]) : null;
};

// ----------------------------------------------------------------- arxiv

async function arxivSearch(query, { max = 5, sort = "relevance", year } = {}) {
  const sortBy = sort === "date" ? "submittedDate" : "relevance";
  // arXiv's submittedDate range syntax is unreliable (often returns zero
  // entries); fetch a larger pool and filter by year client-side instead.
  const fetchMax = year ? Math.min(Number(max) * 8 + 20, 100) : max;
  const url =
    "https://export.arxiv.org/api/query?" +
    new URLSearchParams({
      search_query: `all:${query}`,
      start: "0",
      max_results: String(fetchMax),
      sortBy,
      sortOrder: "descending",
    });
  const xml = await request(url, { accept: "application/atom+xml" });
  const wanted = year ? String(year) : null;
  return xmlBlocks(xml, "entry")
    .map((e) => {
      const id = (e.match(/<id>[^<]*\/abs\/([^<]+)<\/id>/) || [])[1] || null;
      const authors = xmlBlocks(e, "author").map((a) => xmlText(a, "name"));
      return {
        source: "arxiv",
        title: xmlText(e, "title"),
        authors,
        year: yearOf(xmlText(e, "published")),
        published: xmlText(e, "published"),
        abstract: xmlText(e, "summary"),
        id,
        doi: xmlText(e, "arxiv:doi"),
        url: id ? `https://arxiv.org/abs/${id}` : null,
        pdf: id ? `https://arxiv.org/pdf/${id}` : null,
        categories: xmlBlocks(e, "category")
          .map((c) => (c.match(/term="([^"]+)"/) || [])[1])
          .filter(Boolean),
      };
    })
    .filter((p) => !wanted || String(p.year) === wanted)
    .slice(0, max);
}

async function arxivById(id) {
  const clean = String(id).replace(/^arxiv:/i, "").replace(/v\d+$/, "");
  const url =
    "https://export.arxiv.org/api/query?" +
    new URLSearchParams({ id_list: clean, max_results: "1" });
  const xml = await request(url, { accept: "application/atom+xml" });
  const [e] = xmlBlocks(xml, "entry");
  if (!e) return null;
  const aid = (e.match(/<id>[^<]*\/abs\/([^<]+)<\/id>/) || [])[1] || clean;
  return {
    source: "arxiv",
    title: xmlText(e, "title"),
    authors: xmlBlocks(e, "author").map((a) => xmlText(a, "name")),
    year: yearOf(xmlText(e, "published")),
    published: xmlText(e, "published"),
    abstract: xmlText(e, "summary"),
    id: aid,
    doi: xmlText(e, "arxiv:doi"),
    url: `https://arxiv.org/abs/${aid}`,
    pdf: `https://arxiv.org/pdf/${aid}`,
    categories: xmlBlocks(e, "category")
      .map((c) => (c.match(/term="([^"]+)"/) || [])[1])
      .filter(Boolean),
  };
}

// --------------------------------------------------------------- crossref

// CrossRef and OpenAlex both run a "polite pool": identifying yourself with a
// contact address moves you to a more generous rate-limit bucket. No key.
function politeParams() {
  const mail = cred("mailto");
  return mail ? { mailto: mail } : {};
}

function politeHeaders() {
  const mail = cred("mailto");
  return mail ? { "User-Agent": `${UA} (mailto:${mail})` } : {};
}

async function crossrefSearch(query, { max = 5, year, author } = {}) {
  const params = {
    "query.bibliographic": query,
    rows: String(max),
    select: "title,DOI,issued,author,is-referenced-by-count,container-title,abstract,type",
    ...politeParams(),
  };
  if (author) params["query.author"] = author;
  if (year) params.filter = `from-pub-date:${year}`;
  const url = "https://api.crossref.org/works?" + new URLSearchParams(params);
  const j = await getJson(url, undefined, politeHeaders());
  return (j.message?.items || []).map((it) => ({
    source: "crossref",
    title: (it.title || [])[0] || null,
    authors: authorsOf((it.author || []).map((a) => [a.given, a.family].filter(Boolean).join(" "))),
    year: yearOf(it.issued?.["date-parts"]?.[0]?.[0]),
    abstract: it.abstract ? stripTags(it.abstract) : null,
    id: it.DOI,
    doi: it.DOI,
    venue: (it["container-title"] || [])[0] || null,
    citations: it["is-referenced-by-count"] ?? null,
    type: it.type || null,
    url: it.DOI ? `https://doi.org/${it.DOI}` : null,
  }));
}

async function crossrefByDoi(doi) {
  const url =
    "https://api.crossref.org/works/" +
    encodeURIComponent(doi.replace(/^doi:/i, "")) +
    (cred("mailto") ? "?mailto=" + encodeURIComponent(cred("mailto")) : "");
  const j = await getJson(url, undefined, politeHeaders());
  const it = j.message || {};
  return {
    source: "crossref",
    title: (it.title || [])[0] || null,
    authors: authorsOf((it.author || []).map((a) => [a.given, a.family].filter(Boolean).join(" "))),
    year: yearOf(it.issued?.["date-parts"]?.[0]?.[0]),
    abstract: it.abstract ? stripTags(it.abstract) : null,
    id: it.DOI,
    doi: it.DOI,
    venue: (it["container-title"] || [])[0] || null,
    citations: it["is-referenced-by-count"] ?? null,
    type: it.type || null,
    url: it.DOI ? `https://doi.org/${it.DOI}` : null,
  };
}

// ----------------------------------------------------------------- pubmed

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

// NCBI accepts an optional api_key as a query parameter: 3 -> 10 req/sec.
function eutilsParams(extra) {
  const k = cred("pubmed");
  return { ...extra, ...(k ? { api_key: k } : {}) };
}

async function pubmedSearch(query, { max = 5, year } = {}) {
  const term = year ? `(${query}) AND ("${year}"[dp])` : query;
  const s = await getJson(
    `${EUTILS}/esearch.fcgi?` +
      new URLSearchParams(
        eutilsParams({ db: "pubmed", term, retmax: String(max), retmode: "json" })
      )
  );
  const ids = s.esearchresult?.idlist || [];
  if (!ids.length) return [];
  const sum = await getJson(
    `${EUTILS}/esummary.fcgi?` +
      new URLSearchParams(eutilsParams({ db: "pubmed", id: ids.join(","), retmode: "json" }))
  );
  return ids
    .map((pmid) => sum.result?.[pmid])
    .filter(Boolean)
    .map((r) => ({
      source: "pubmed",
      title: r.title || null,
      authors: authorsOf((r.authors || []).map((a) => a.name)),
      year: yearOf(r.pubdate),
      published: r.pubdate || null,
      abstract: null,
      id: r.uid,
      doi: (r.articleids || []).find((a) => a.idtype === "doi")?.value || null,
      venue: r.fulljournalname || r.source || null,
      url: `https://pubmed.ncbi.nlm.nih.gov/${r.uid}/`,
    }));
}

// ------------------------------------------------------- semantic scholar

const S2 = "https://api.semanticscholar.org/graph/v1";
const S2_FIELDS = "title,year,authors,externalIds,citationCount,abstract,openAccessPdf,venue";

// Semantic Scholar takes the key in an x-api-key header (not a query param).
// Without one, anonymous callers get intermittent HTTP 429.
function s2Headers() {
  const k = cred("s2");
  return k ? { "x-api-key": k } : {};
}

async function s2Search(query, { max = 5, year } = {}) {
  const params = { query, limit: String(max), fields: S2_FIELDS };
  if (year) params.year = String(year);
  const j = await getJson(
    `${S2}/paper/search?` + new URLSearchParams(params),
    undefined,
    s2Headers()
  );
  return (j.data || []).map((p) => ({
    source: "s2",
    title: p.title,
    authors: authorsOf((p.authors || []).map((a) => a.name)),
    year: p.year,
    abstract: p.abstract,
    id: p.paperId,
    doi: p.externalIds?.DOI || null,
    arxiv: p.externalIds?.ArXiv || null,
    citations: p.citationCount ?? null,
    venue: p.venue || null,
    url: p.externalIds?.DOI
      ? `https://doi.org/${p.externalIds.DOI}`
      : p.paperId
        ? `https://www.semanticscholar.org/paper/${p.paperId}`
        : null,
    pdf: p.openAccessPdf?.url || null,
  }));
}

async function s2ByDoi(doi) {
  const p = await getJson(
    `${S2}/paper/DOI:${encodeURIComponent(doi)}?fields=${S2_FIELDS}`,
    undefined,
    s2Headers()
  );
  return {
    source: "s2",
    title: p.title,
    authors: authorsOf((p.authors || []).map((a) => a.name)),
    year: p.year,
    abstract: p.abstract,
    id: p.paperId,
    doi: p.externalIds?.DOI || doi,
    arxiv: p.externalIds?.ArXiv || null,
    citations: p.citationCount ?? null,
    venue: p.venue || null,
    url: `https://www.semanticscholar.org/paper/${p.paperId}`,
    pdf: p.openAccessPdf?.url || null,
  };
}

// ------------------------------------------------------------------ output

function renderPaper(p, i) {
  const lines = [];
  lines.push(`${i != null ? `${i + 1}. ` : ""}${p.title || "(untitled)"}`);
  if (p.authors?.length) lines.push(`   ${p.authors.join(", ")}`);
  const meta = [];
  if (p.year) meta.push(p.year);
  if (p.venue) meta.push(p.venue);
  if (p.citations != null) meta.push(`cited ${p.citations}`);
  if (meta.length) lines.push(`   ${meta.join(" · ")}`);
  const ids = [];
  if (p.doi) ids.push(`DOI:${p.doi}`);
  if (p.arxiv) ids.push(`arXiv:${p.arxiv}`);
  else if (p.source === "arxiv" && p.id) ids.push(`arXiv:${p.id}`);
  if (p.source === "pubmed" && p.id) ids.push(`PMID:${p.id}`);
  if (ids.length) lines.push(`   ${ids.join("  ")}`);
  if (p.url) lines.push(`   ${p.url}`);
  if (p.abstract) lines.push(`   > ${p.abstract.slice(0, 400)}${p.abstract.length > 400 ? "…" : ""}`);
  return lines.join("\n");
}

function renderSection(name, papers, err) {
  const head = `## ${name}`;
  if (err) return `${head}\n  ! ${err}`;
  if (!papers?.length) return `${head}\n  (no results)`;
  return head + "\n" + papers.map((p, i) => renderPaper(p, i)).join("\n\n");
}

// -------------------------------------------------------------------- cli

const SOURCES = {
  arxiv: arxivSearch,
  crossref: crossrefSearch,
  pubmed: pubmedSearch,
  s2: s2Search,
};

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json" || a === "-j") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--source" || a === "-s") opts.source = argv[++i];
    else if (a === "--max" || a === "-m") opts.max = Number(argv[++i]) || 5;
    else if (a === "--year" || a === "-y") opts.year = argv[++i];
    else if (a === "--author" || a === "-a") opts.author = argv[++i];
    else if (a === "--sort") opts.sort = argv[++i];
    else if (a === "--s2-key") CLI_CREDS.s2 = argv[++i];
    else if (a === "--pubmed-key") CLI_CREDS.pubmed = argv[++i];
    else if (a === "--mailto") CLI_CREDS.mailto = argv[++i];
    else opts._.push(a);
  }
  return opts;
}

async function cmdKeys() {
  console.log("credential resolution (highest first: flag > env > config > anonymous)\n");
  const rows = [
    ["s2", "ARS_S2_API_KEY", "x-api-key header — removes HTTP 429"],
    ["pubmed", "ARS_PUBMED_API_KEY", "api_key param — 3 req/s -> 10 req/s"],
    ["mailto", "ARS_MAILTO", "polite pool for crossref + openalex"],
  ];
  for (const [name, env, effect] of rows) {
    const src = credSource(name);
    const val = cred(name);
    let shown = "(not set — anonymous)";
    if (src) {
      // Never print a secret in full; show enough to tell keys apart.
      const preview =
        name === "mailto"
          ? val
          : val.length > 12
            ? `${val.slice(0, 6)}…${val.slice(-4)}`
            : `${val.slice(0, 3)}…`;
      shown = `${preview}   [${src}]`;
    }
    console.log(`  ${name.padEnd(7)} ${shown}`);
    console.log(`          ${effect}`);
  }
  console.log(
    `\nconfig file: ${CONFIG.file ? CONFIG.file : "(none found)"}` +
      `\nsearched:   ${CONFIG_PATHS.join("\n            ")}`
  );
  console.log(
    `\nformat:     {"s2":"...","pubmed":"...","mailto":"you@example.com"}` +
      `\n            (a nested "keys" object works too)`
  );
}

const USAGE = `ars — academic search CLI (zero-dependency)

USAGE
  ars search "<query>" [options]
  ars paper  <DOI|arXiv-id|PMID> [--json]
  ars fulltext <arXiv-id>
  ars sources
  ars keys

OPTIONS
  -s, --source <name>   arxiv|crossref|pubmed|s2|all   (default: all)
  -m, --max <n>         results per source             (default: 5)
  -y, --year <year>     year filter (search only)
  -a, --author <name>   author filter (crossref)
      --sort <mode>     relevance|date                 (arxiv only)
  -j, --json            emit JSON instead of Markdown

CREDENTIALS (all optional; every source works anonymously)
      --s2-key <k>      Semantic Scholar key (removes 429)
      --pubmed-key <k>  NCBI key (3 -> 10 requests/sec)
      --mailto <email>  contact address for the CrossRef/OpenAlex polite pool

  Resolution order: flag > environment > config file > anonymous.
  Env vars: ARS_S2_API_KEY, ARS_PUBMED_API_KEY, ARS_MAILTO
  Config:   ~/.config/ars/config.json   {"s2":"...","mailto":"you@example.com"}
  Run \`ars keys\` to see what is currently in effect (secrets are masked).

NOTES
  arXiv covers CS/physics/math preprints; crossref covers published
  journals (broad); pubmed covers biomedical with MeSH; s2 adds citation
  counts and open-access PDF links. s2 rate-limits anonymous callers and
  returns 429 intermittently — supply a key if you rely on it.
  This CLI deliberately bypasses http_proxy: Node's core https module
  ignores it, and OpenAlex rejects a shared proxy IP. Leave it that way.
`;

async function cmdSearch(opts) {
  const query = opts._.join(" ").trim();
  if (!query) {
    console.error("error: empty query");
    process.exit(2);
  }
  const want = opts.source && opts.source !== "all" ? [opts.source] : Object.keys(SOURCES);
  for (const s of want) {
    if (!SOURCES[s]) {
      console.error(`error: unknown source "${s}" (have: ${Object.keys(SOURCES).join(", ")})`);
      process.exit(2);
    }
  }
  const args = { max: opts.max || 5, year: opts.year, author: opts.author, sort: opts.sort };

  const settled = await Promise.allSettled(want.map((s) => SOURCES[s](query, args)));
  const results = {};
  const errors = {};
  want.forEach((s, i) => {
    const r = settled[i];
    if (r.status === "fulfilled") results[s] = r.value;
    else errors[s] = r.reason?.message || String(r.reason);
  });

  if (opts.json) {
    console.log(JSON.stringify({ query, results, errors }, null, 2));
    return;
  }
  const parts = [`# Search: ${query}`, ""];
  for (const s of want) parts.push(renderSection(s, results[s], errors[s]), "");
  console.log(parts.join("\n"));

  // Deduplicate across sources by DOI/arXiv id so the caller sees one line per work.
  const seen = new Map();
  for (const s of want) {
    for (const p of results[s] || []) {
      const key = (p.doi || p.arxiv || p.id || p.title || "").toString().toLowerCase();
      if (!key) continue;
      if (seen.has(key)) {
        const prev = seen.get(key);
        if (!prev.also.includes(s)) prev.also.push(s);
      } else {
        seen.set(key, { ...p, also: [s] });
      }
    }
  }
  const dupes = [...seen.values()].filter((p) => p.also.length > 1);
  if (dupes.length) {
    console.log(`## duplicates across sources (${dupes.length})`);
    for (const d of dupes) console.log(`  - ${d.also.join(" + ")}: ${d.title}`);
  }
}

async function cmdPaper(opts) {
  const id = (opts._[0] || "").trim();
  if (!id) {
    console.error("error: missing identifier");
    process.exit(2);
  }
  const isDoi = /^10\.\d{4,9}\//.test(id.replace(/^doi:/i, ""));
  const isPmid = /^pmid:/i.test(id) || /^\d{7,8}$/.test(id);
  const isArxiv = /^arxiv:/i.test(id) || /^\d{4}\.\d{4,5}(v\d+)?$/.test(id);

  let out;
  if (isDoi) {
    const doi = id.replace(/^doi:/i, "");
    try {
      out = await crossrefByDoi(doi);
    } catch (e) {
      out = await s2ByDoi(doi);
    }
  } else if (isArxiv) {
    out = await arxivById(id);
  } else if (isPmid) {
    const pmid = id.replace(/^pmid:/i, "");
    const sum = await getJson(
      `${EUTILS}/esummary.fcgi?` + new URLSearchParams({ db: "pubmed", id: pmid, retmode: "json" })
    );
    const r = sum.result?.[pmid];
    out = r
      ? {
          source: "pubmed",
          title: r.title,
          authors: authorsOf((r.authors || []).map((a) => a.name)),
          year: yearOf(r.pubdate),
          id: pmid,
          doi: (r.articleids || []).find((a) => a.idtype === "doi")?.value || null,
          venue: r.fulljournalname || r.source,
          url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
        }
      : null;
  } else {
    console.error(`error: unrecognized identifier "${id}" (expected DOI, arXiv id, or PMID)`);
    process.exit(2);
  }

  if (!out) {
    console.error("not found");
    process.exit(1);
  }
  console.log(opts.json ? JSON.stringify(out, null, 2) : renderPaper(out, null));
}

async function cmdFulltext(opts) {
  const id = (opts._[0] || "").replace(/^arxiv:/i, "").replace(/v\d+$/, "");
  if (!id) {
    console.error("error: missing arXiv id");
    process.exit(2);
  }
  const url = `https://arxiv.org/abs/${id}`;
  const html = await request(url, { accept: "text/html" });

  // Prefer the citation_* meta tags: stable across arXiv's HTML redesigns,
  // unlike the blockquote classes which have changed name (abstract mathjax).
  const meta = (name) => {
    const m = html.match(
      new RegExp(`<meta\\s+name="${name}"\\s+content="([\\s\\S]*?)"\\s*/?>`, "i")
    );
    return m ? stripTags(m[1]) : null;
  };
  const title = meta("citation_title");
  const abstract =
    meta("citation_abstract") ||
    stripTags((html.match(/<blockquote class="abstract[^"]*">([\s\S]*?)<\/blockquote>/i) || [])[1] || "");

  console.log(`# ${title || id}`);
  console.log(`\nSource: ${url}\n`);
  console.log(abstract ? abstract.replace(/^Abstract:\s*/i, "") : "(abstract not found on page)");
}

async function cmdSources() {
  const checks = [
    ["arxiv", "https://export.arxiv.org/api/query?search_query=all:test&max_results=1"],
    ["crossref", "https://api.crossref.org/works?query=test&rows=1"],
    ["pubmed", `${EUTILS}/esearch.fcgi?db=pubmed&term=test&retmax=1&retmode=json`],
    ["s2", `${S2}/paper/search?query=test&limit=1&fields=title`],
    ["openalex", "https://api.openalex.org/works?search=test&per-page=1"],
  ];
  const out = await Promise.all(
    checks.map(async ([name, url]) => {
      const t0 = Date.now();
      try {
        await request(url);
        return { name, ok: true, ms: Date.now() - t0 };
      } catch (e) {
        return { name, ok: false, ms: Date.now() - t0, err: e.message, body: e.body };
      }
    })
  );
  for (const r of out) {
    const mark = r.ok ? "OK  " : "FAIL";
    let extra = `${r.ms}ms`;
    if (!r.ok) extra += ` — ${r.err}${r.body ? ": " + r.body.slice(0, 120) : ""}`;
    console.log(`${mark} ${r.name.padEnd(9)} ${extra}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const opts = parseArgs(argv.slice(1));

  if (!cmd || opts.help || cmd === "help") {
    console.log(USAGE);
    return;
  }
  switch (cmd) {
    case "search":
      return cmdSearch(opts);
    case "paper":
      return cmdPaper(opts);
    case "fulltext":
      return cmdFulltext(opts);
    case "sources":
      return cmdSources();
    case "keys":
      return cmdKeys();
    default:
      console.error(`error: unknown command "${cmd}"\n`);
      console.log(USAGE);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error("error:", e.message);
  process.exit(1);
});
