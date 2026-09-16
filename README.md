# academic-search

Academic literature search as a **zero-dependency CLI**. Finds papers, resolves
identifiers, and pulls arXiv abstracts — without an MCP server, an API key, a
daemon, or a JSON-RPC handshake.

```bash
node ars.cjs search "conflict-free replicated data types"
node ars.cjs paper 10.1145/2517349.2522737
```

This is a skill for coding agents (ZCode, Claude Code, Codex, Cursor, …), but
`ars.cjs` is an ordinary command-line tool — it works fine on its own.

## Why this exists

Agent search tools are usually MCP servers. That means a JSON-RPC connection, a
per-client config file, and a re-install every time you switch agent software.
This is the opposite: one script, plain HTTPS, one call in and one result out.

It was written after the MCP-based academic stack broke in exactly these ways.
They are worth knowing, because none of them is obvious from the error message:

- **OpenAlex now bills per request** and meters you by *exit IP*. Behind a
  shared proxy it answers `HTTP 403 Insufficient budget` even when you have
  never used it. The old tool inherited `http_proxy` and used OpenAlex as its
  default first source — so every search sat waiting on a request that was
  always going to fail. **This CLI deliberately bypasses `http_proxy`**; Node's
  core `https` module ignores it. Do not "fix" that.
- **Semantic Scholar rate-limits anonymous callers** with intermittent `429`s.
  A key fixes it, but is optional.
- **Academic APIs match literal words**, not intent. Search with the field's
  own vocabulary (`"conflict-free replicated data types"`), not a description
  of your problem (`"how to sync state across clients"`). Getting this wrong is
  the single biggest cause of bad results.

See `skill/SKILL.md` for the full usage reference and source-by-source notes.

## Install

```bash
git clone https://github.com/CelestNya/academic-search.git
cd academic-search
node install.js
```

`install.js` detects which agent home directories exist on the machine and
copies the skill into each one's `skills/` folder. Nothing is installed for an
agent you don't have.

```
node install.js            # install everywhere detected
node install.js --list     # show targets, change nothing
node install.js --target <dir>   # one specific directory
node install.js --force    # overwrite an existing copy that differs
node install.js --uninstall      # remove every copy
```

It will not silently overwrite a copy that differs from this repository — that
usually means you edited it locally. Pass `--force` if you mean it.

## Usage

```bash
ARS=~/.zcode/skills/academic-search/ars.cjs   # path depends on your agent

node $ARS search "graph neural networks"              # all 4 sources, deduped
node $ARS search "radiology deep learning" -s pubmed -y 2023
node $ARS search "transformers" -s arxiv --sort date -m 10
node $ARS paper 2212.02618                            # arXiv id
node $ARS paper 10.1145/2517349.2522737               # DOI
node $ARS paper 31375564                              # PMID
node $ARS fulltext 2212.02618                         # abstract page
node $ARS sources                                     # are the APIs up?
node $ARS keys                                        # credential state, masked
node $ARS search "CRDT" --json                        # machine-readable
```

| Flag | Meaning |
|---|---|
| `-s, --source` | `arxiv` / `crossref` / `pubmed` / `s2` / `all` (default) |
| `-m, --max` | results per source (default 5) |
| `-y, --year` | year filter |
| `-a, --author` | author filter (CrossRef) |
| `--sort` | `relevance` / `date` (arXiv) |
| `-j, --json` | JSON instead of Markdown |

## Sources

| Source | Covers | Typical latency |
|---|---|---|
| `arxiv` | CS / physics / math / bio preprints | ~0.7 s |
| `crossref` | published journals, broad | ~1.5 s |
| `pubmed` | biomedical (MeSH syntax supported) | ~1.0 s |
| `s2` | all fields + citation counts, OA PDFs | intermittent `429` |

`all` queries them in parallel and deduplicates across sources by DOI/arXiv ID.

## Credentials — all optional

Every source works anonymously. Keys only raise rate limits:

```json
// ~/.config/ars/config.json
{
  "s2": "your-semantic-scholar-key",
  "pubmed": "your-ncbi-key",
  "mailto": "you@example.com"
}
```

Resolution order is `--flag` > environment variable > config file > anonymous.
Environment variables: `ARS_S2_API_KEY`, `ARS_PUBMED_API_KEY`, `ARS_MAILTO`.
Run `ars keys` to see what is in effect — secrets are masked.

The config file is intentionally **outside** this repository and outside the
skill directory, so a key never travels with a clone or a shared skill folder.

## Requirements

Node.js 14 or newer. That's it. No `npm install`, no Python, no `uv`.

## License

MIT — see [LICENSE](LICENSE).
