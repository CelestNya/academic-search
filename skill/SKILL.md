---
name: academic-search
description: Search academic literature (arXiv, CrossRef, PubMed, Semantic Scholar) and resolve papers by DOI/arXiv ID/PMID. Use when looking for papers, preprints, citations, or scholarly references. Zero-dependency CLI; no MCP server or API key required.
version: 1.0.0
---

# Academic Search (ars)

Zero-dependency CLI for scholarly literature. One command in, results out —
no MCP server, no JSON-RPC handshake, no daemon, no install step beyond Node.

## When to use this

Use this skill for **academic literature**, not general web search:

- Finding papers / preprints by topic, author, or title
- Resolving a DOI, arXiv ID, or PMID to full metadata
- Getting citation counts or open-access PDF links
- Pulling an arXiv abstract

For general web search, news, docs, or error messages, use the `anysearch`
skill instead. Its academic vertical (`--domain academic`) is a fallback, but
this CLI hits the scholarly APIs directly and is faster and more precise.

## Commands

```bash
ARS=~/.zcode/skills/academic-search/ars.cjs

# Search across all sources (parallel; per-source failures don't block)
node $ARS search "conflict-free replicated data types"
node $ARS search "CRDT collaboration" --max 10
node $ARS search "transformer attention" --source arxiv --sort date
node $ARS search "radiology deep learning" --source pubmed
node $ARS search "graph neural networks" --author Kipf --year 2017

# Resolve a known identifier (DOI / arXiv id / PMID all auto-detected)
node $ARS paper 10.1145/2517349.2522737
node $ARS paper 2212.02618
node $ARS paper 31375564

# arXiv abstract page
node $ARS fulltext 2212.02618

# Check which upstream APIs are currently reachable
node $ARS sources

# Machine-readable output for further processing
node $ARS search "CRDT" --source arxiv --json
```

Options: `-s/--source` (arxiv|crossref|pubmed|s2|all), `-m/--max`,
`-y/--year`, `-a/--author`, `--sort relevance|date`, `-j/--json`,
plus the credential flags below.

## Credentials (all optional)

**Every source works anonymously.** No key is required to use this skill.
Keys exist only to raise rate limits, and each source wants a different
thing:

| Source | Credential | Effect |
|---|---|---|
| `s2` | `--s2-key` | sent as an `x-api-key` header; removes intermittent HTTP 429 |
| `pubmed` | `--pubmed-key` | sent as an `api_key` query param; 3 → 10 requests/sec |
| `crossref`, `openalex` | `--mailto` | polite pool: moves you to a more generous rate-limit bucket |

`pubmed` is the one to set first if you run batches — NCBI's anonymous limit
of 3 requests/sec is low enough to bite during a literature review.

### Resolution order

```
--flag  >  environment variable  >  config file  >  anonymous
```

Environment variables: `ARS_S2_API_KEY`, `ARS_PUBMED_API_KEY`, `ARS_MAILTO`.

Config file — `~/.config/ars/config.json`:

```json
{
  "s2": "your-semantic-scholar-key",
  "pubmed": "your-ncbi-key",
  "mailto": "you@example.com"
}
```

A nested `{"keys": {...}}` object is also accepted. Override the location with
`ARS_CONFIG=/path/to/config.json`, or use `~/.arsrc.json` as a fallback.

**The config file deliberately lives outside the skill directory.** This skill
is meant to be copied between machines and agent tools, and credentials must
not travel with it. Don't add a `.env` inside the skill directory.

### Inspecting credential state

```bash
node $ARS keys        # shows what is in effect, with secrets masked
```

Secrets are never printed in full — only a short preview plus the source
(`flag` / `env:NAME` / `file:/path`). Safe to paste into a conversation.

## Sources

| Source | Covers | Notes |
|---|---|---|
| `arxiv` | CS / physics / math / bio preprints | fastest (~1s); has PDF links |
| `crossref` | published journals, broad | authoritative DOIs, citation counts |
| `pubmed` | biomedical | supports MeSH term syntax in the query |
| `s2` | all fields + citation graph | **rate-limits anonymous callers (HTTP 429)** |

Default is `all` — the four run in parallel and results are deduplicated
across sources by DOI/arXiv ID, with a summary of overlaps at the end.

## Known limitations

- **`s2` returns HTTP 429 intermittently.** Semantic Scholar requires an API
  key for reliable anonymous use. When it fails, the other three sources still
  return; just don't rely on `s2` alone. Its citation counts are the main thing
  you lose.
- **Query phrasing matters.** These APIs match against titles and abstracts,
  so the *paper's own vocabulary* works far better than a description of the
  problem. `"conflict-free replicated data types"` returns the CRDT literature;
  `"how to sync state across clients"` returns noise. Use the standard term for
  the concept, or search arXiv by author + keyword.
- **`crossref` abstracts are often missing** — many publishers don't deposit
  them. Missing abstract is not a missing paper.
- **`pubmed` needs biomedical vocabulary.** A CS query returns nothing there.
  That is expected, not a failure.
- **`--year` on arXiv can come back empty for old years.** arXiv's relevance
  ranking skews heavily toward recent papers, so filtering a 2017 query
  against the top-ranked pool often yields nothing even though such papers
  exist. If you need a specific older paper, search its title or author
  instead of relying on a year filter. (`crossref` and `pubmed` handle year
  filters natively and are better for historical searches.)

## Why not OpenAlex

OpenAlex is excluded as a search source on purpose. It now bills per request
($0.001) and the free daily credit is consumed by **shared-proxy traffic** —
not by this CLI. `ars sources` probes it through Node's direct connection and
usually reports OK, but any request routed through the local proxy
(`127.0.0.1:7897`) comes back `HTTP 403 Insufficient budget`, because OpenAlex
meters that proxy's shared exit IP rather than this machine.

This is the real reason the previous MCP-based `smart_search` hung for its
full timeout: it inherited the proxy environment and OpenAlex was its default
first source, so every call sat waiting on a 403'd request.

**Do not add proxy support to this CLI.** It deliberately uses Node's core
`https` module, which ignores `http_proxy`/`https_proxy`. Going direct is what
keeps OpenAlex and other shared-IP-rate-limited sources working. When a source
fails, run `ars sources` first — it distinguishes "this endpoint is down" from
"this endpoint rejects our proxy IP".
