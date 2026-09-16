#!/usr/bin/env node
/**
 * Installer for the academic-search skill.
 *
 * Copies skill/ into every agent skill directory it can find, so the same
 * clone serves ZCode, Claude Code, Codex, Cursor and friends without any
 * per-tool packaging. Zero dependencies.
 *
 *   node install.js                 install into every detected agent dir
 *   node install.js --list          show what would be targeted, change nothing
 *   node install.js --target <dir>  install into one specific directory
 *   node install.js --uninstall     remove every copy this installer made
 *   node install.js --force         overwrite an existing installation
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const SKILL_NAME = "academic-search";
const SRC = path.join(__dirname, "skill");

// Directories that agents read skills from. Kept as data so adding a new
// agent is a one-line change rather than a code edit.
const CANDIDATES = [
  { label: "ZCode", dir: ".zcode/skills" },
  { label: "Claude Code", dir: ".claude/skills" },
  { label: "shared agents", dir: ".agents/skills" },
  { label: "Codex", dir: ".codex/skills" },
  { label: "Cursor", dir: ".cursor/skills" },
  { label: "OpenCode", dir: ".config/opencode/skills" },
  { label: "Windsurf", dir: ".codeium/windsurf/skills" },
];

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valOf = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};

const LIST_ONLY = has("--list");
const FORCE = has("--force");
const UNINSTALL = has("--uninstall");
const EXPLICIT = valOf("--target");

function readSkillMeta() {
  const md = fs.readFileSync(path.join(SRC, "SKILL.md"), "utf8");
  const fm = md.startsWith("---") ? md.slice(3, md.indexOf("---", 3)) : "";
  const pick = (k) => {
    const m = fm.match(new RegExp(`^${k}:\\s*(.+)$`, "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
  };
  return { name: pick("name") || SKILL_NAME, version: pick("version") || "?" };
}

// A candidate counts as "present" only if its parent agent home exists —
// creating ~/.windsurf for someone who has never used Windsurf just leaves
// litter on their disk.
function detectTargets() {
  if (EXPLICIT) return [{ label: "explicit", dir: path.resolve(EXPLICIT) }];
  const home = os.homedir();
  const out = [];
  for (const c of CANDIDATES) {
    const full = path.join(home, c.dir);
    const homeDir = path.join(home, c.dir.split("/")[0]);
    if (fs.existsSync(homeDir)) out.push({ label: c.label, dir: full });
  }
  return out;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// The CLI entry point is whichever .cjs/.js ships beside SKILL.md. Resolving it
// by inspection keeps the installer working if the file is ever renamed.
function entryFile() {
  const names = fs.readdirSync(SRC);
  return names.find((n) => n.endsWith(".cjs")) || names.find((n) => n.endsWith(".js")) || null;
}

function entryPathIn(dir) {
  const f = entryFile();
  return f ? path.join(dir, f) : null;
}

function install() {
  const meta = readSkillMeta();
  console.log(`academic-search v${meta.version} — installing from ${SRC}\n`);
  const targets = detectTargets();
  if (!targets.length) {
    console.error("No agent skill directory found. Use --target <dir> to place it manually.");
    process.exit(1);
  }

  let installed = 0;
  let firstDest = null;
  for (const t of targets) {
    const dest = path.join(t.dir, meta.name);
    if (LIST_ONLY) {
      const state = fs.existsSync(dest) ? "would overwrite" : "would install";
      console.log(`  [${t.label}] ${dest}  (${state})`);
      continue;
    }
    if (fs.existsSync(dest) && !FORCE) {
      // Never clobber silently: the destination may hold local edits.
      const srcEntry = entryPathIn(SRC);
      const dstEntry = entryPathIn(dest);
      const same =
        srcEntry && dstEntry && fs.existsSync(dstEntry) &&
        fs.readFileSync(dstEntry, "utf8") === fs.readFileSync(srcEntry, "utf8");
      if (same) {
        console.log(`  [${t.label}] already up to date — skipped`);
        installed++;
        continue;
      }
      console.log(`  [${t.label}] EXISTS and differs — skipped (use --force to overwrite)`);
      continue;
    }
    // Overwriting with --force must also drop files that no longer exist in
    // this repo (e.g. a renamed entry point), or the stale copy keeps working
    // by accident and hides the upgrade.
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    copyDir(SRC, dest);
    console.log(`  [${t.label}] installed -> ${dest}`);
    installed++;
    if (!firstDest) firstDest = path.join(dest, entryFile() || "ars.cjs");
  }
  if (!LIST_ONLY) {
    console.log(`\n${installed} location(s) ready.`);
    if (firstDest) console.log(`Try: node "${firstDest}" search "CRDT"`);
  }
}

function uninstall() {
  const meta = readSkillMeta();
  let removed = 0;
  for (const t of detectTargets()) {
    const dest = path.join(t.dir, meta.name);
    if (!fs.existsSync(dest)) continue;
    if (LIST_ONLY) {
      console.log(`  [${t.label}] would remove ${dest}`);
      continue;
    }
    fs.rmSync(dest, { recursive: true, force: true });
    console.log(`  [${t.label}] removed ${dest}`);
    removed++;
  }
  if (!LIST_ONLY) console.log(`\n${removed} location(s) removed.`);
}

if (UNINSTALL) uninstall();
else install();
