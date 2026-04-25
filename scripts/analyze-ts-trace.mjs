#!/usr/bin/env node
/**
 * Analyze a TypeScript `--generateTrace` emit (trace.json) and print the
 * largest `checkSourceFile` hot spots as an indented tree.
 *
 * Usage:
 *   node analyze-ts-trace.mjs <trace.json> [options]
 *
 * Options:
 *   -o, --out <dir>       Write analysis.txt into <dir> in addition to stdout.
 *   -d, --depth <n>       Max tree depth to print (default: 10).
 *   -t, --top <n>         Number of hottest checkSourceFile entries (default: 3).
 *   -c, --children <n>    Number of hottest children per node (default: 5).
 *   -h, --help            Show this help.
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const HELP = `Usage: node analyze-ts-trace.mjs <trace.json> [options]

Analyzes a TypeScript \`--generateTrace\` emit and prints the hottest
\`checkSourceFile\` subtrees. With --out, also writes <dir>/analysis.txt.

Options:
  -o, --out <dir>       Write analysis.txt into <dir>.
  -d, --depth <n>       Max tree depth to print (default: 10).
  -t, --top <n>         Number of hottest checkSourceFile entries (default: 3).
  -c, --children <n>    Number of hottest children per node (default: 5).
  -h, --help            Show this help.
`;

let parsed;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      out: { type: "string", short: "o" },
      depth: { type: "string", short: "d" },
      top: { type: "string", short: "t" },
      children: { type: "string", short: "c" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
} catch (err) {
  console.error(err.message);
  console.error(HELP);
  process.exit(1);
}

const { values, positionals } = parsed;

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

if (positionals.length === 0) {
  console.error("error: missing <trace.json> path");
  console.error(HELP);
  process.exit(1);
}

const tracePath = positionals[0];

function parseIntArg(name, raw, fallback) {
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`error: --${name} must be a positive integer (got "${raw}")`);
    process.exit(1);
  }
  return n;
}

const maxDepth = parseIntArg("depth", values.depth, 10);
const topN = parseIntArg("top", values.top, 3);
const childN = parseIntArg("children", values.children, 5);

let raw;
try {
  raw = JSON.parse(fs.readFileSync(tracePath, "utf8"));
} catch (err) {
  console.error(`error: failed to read/parse "${tracePath}": ${err.message}`);
  process.exit(1);
}

// TypeScript emits Chrome's "Array Format". Some tools wrap it in
// `{ traceEvents: [...] }` ("Object Format"). Accept both.
const events = Array.isArray(raw) ? raw : raw?.traceEvents;
if (!Array.isArray(events)) {
  console.error(
    `error: trace file does not contain an event array (expected top-level array or { traceEvents: [...] })`,
  );
  process.exit(1);
}

const stack = [];
const roots = [];

function createNode(e) {
  return {
    name: e.name,
    args: e.args || {},
    start: e.ts,
    duration: 0,
    children: [],
  };
}

for (const e of events) {
  if (e.ph === "B") {
    if (!e.name) continue;
    const node = createNode(e);
    if (stack.length > 0) {
      stack[stack.length - 1].children.push(node);
    } else {
      roots.push(node);
    }
    stack.push(node);
  } else if (e.ph === "E") {
    const node = stack.pop();
    if (node) {
      node.duration = e.ts - node.start;
    }
  } else if (e.ph === "X" && typeof e.dur === "number") {
    if (!e.name) continue;
    const node = createNode(e);
    node.duration = e.dur;
    if (stack.length > 0) {
      stack[stack.length - 1].children.push(node);
    } else {
      roots.push(node);
    }
  }
}

if (stack.length > 0) {
  console.warn(
    `warning: trace ended with ${stack.length} unclosed scope(s); tree may be incomplete`,
  );
}

function formatName(node) {
  const path = node.args?.path || node.args?.file || "";

  if (node.name === "checkSourceFile") {
    return `Check file ${path}`;
  }
  if (node.name === "compareTypes") {
    const { sourceId, targetId } = node.args || {};
    return `Compare types ${sourceId} and ${targetId}`;
  }
  if (node.name === "getVarianceOfType") {
    return `Determine variance of type ${node.args?.typeId}`;
  }
  return node.name;
}

const outputLines = [];
function emit(line = "") {
  outputLines.push(line);
  console.log(line);
}

function printTree(node, indent = "", depth = maxDepth) {
  if (depth <= 0) return;
  const ms = Math.round(node.duration / 1000); // µs → ms
  emit(`${indent}├─ ${formatName(node)} (${ms}ms)`);
  const children = [...node.children].sort((a, b) => b.duration - a.duration);
  for (const child of children.slice(0, childN)) {
    printTree(child, indent + "│  ", depth - 1);
  }
}

const checks = [];
function collectChecks(node) {
  if (node.name === "checkSourceFile") checks.push(node);
  for (const c of node.children) collectChecks(c);
}
roots.forEach(collectChecks);
checks.sort((a, b) => b.duration - a.duration);

emit("Hot Spots");
emit("");

if (checks.length === 0) {
  emit("(no checkSourceFile events found)");
} else {
  for (const check of checks.slice(0, topN)) {
    printTree(check);
    emit("");
  }
}

if (values.out) {
  const outDir = path.resolve(values.out);
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, "analysis.txt");
    fs.writeFileSync(outFile, outputLines.join("\n") + "\n", "utf8");
    console.log(`\nWrote analysis to ${outFile}`);
  } catch (err) {
    console.error(`error: failed to write analysis file: ${err.message}`);
    process.exit(1);
  }
}
