/**
 * Binding to the published Hachure schema (`hachure@^0.5.1`).
 *
 * Ephemeris consumes Flow's emitted run-output TrustBundle, whose shape is owned
 * by Hachure. Rather than re-declare those field names/types by hand (and risk
 * drift), this module loads the normative schema JSON straight out of the
 * `hachure` package and exposes:
 *
 *  - the two schemas Ephemeris cares about (`claim`, `trust-bundle`), and
 *  - a minimal, dependency-free validator for the freshness-bearing fields
 *    Ephemeris actually reads (`claim.id`, `claim.expiresAt`, `claim.ttlSeconds`).
 *
 * We deliberately do NOT pull a full JSON-Schema engine (Ajv et al.) into this
 * zero-runtime-dependency library. Ephemeris reads a tiny, well-known slice of
 * the bundle; the constraints it enforces (`id` required string; `expiresAt`
 * ISO-8601 date-time; `ttlSeconds` integer ≥ 0) are read OUT of the published
 * schema below and asserted against it in tests, so they stay pinned to Hachure.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** Minimal shape of the slice of a JSON-Schema object we read. */
export interface JsonSchema {
  readonly $id?: string;
  readonly title?: string;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchemaProperty>>;
  readonly [key: string]: unknown;
}

export interface JsonSchemaProperty {
  readonly type?: string;
  readonly format?: string;
  readonly minimum?: number;
  readonly description?: string;
  readonly [key: string]: unknown;
}

function loadHachureSchema(name: string): JsonSchema {
  // Resolve the package root from its main entry, then read the schema file the
  // package publishes under `schemas/`. (The package also exposes a
  // `./schemas/*.json` subpath export; reading from disk keeps us off JSON
  // import-attribute behavior that varies across the toolchain.)
  const pkgMain = require.resolve("hachure");
  const schemaPath = join(dirname(pkgMain), "schemas", `${name}.schema.json`);
  return JSON.parse(readFileSync(schemaPath, "utf8")) as JsonSchema;
}

let claimSchemaCache: JsonSchema | undefined;
let trustBundleSchemaCache: JsonSchema | undefined;

/**
 * The published Hachure `claim` schema, read from disk and memoized on first use.
 * Lazy so importing this module has no side effects — a moved or missing schema
 * file surfaces when the schema is actually read, not at import time (ops#30).
 */
export function getClaimSchema(): JsonSchema {
  return (claimSchemaCache ??= loadHachureSchema("claim"));
}

/** The published Hachure `trust-bundle` schema (read from disk, memoized on first use). */
export function getTrustBundleSchema(): JsonSchema {
  return (trustBundleSchemaCache ??= loadHachureSchema("trust-bundle"));
}

/** Issue describing why a claim's freshness fields are not Hachure-valid. */
export interface ValidationIssue {
  readonly field: string;
  readonly message: string;
}

/**
 * Validate the freshness-bearing slice of a claim against the published Hachure
 * `claim` schema's constraints. Only the fields Ephemeris reads are checked;
 * everything else in the claim is intentionally ignored. Returns the list of
 * issues (empty when valid).
 */
export function validateClaimFreshness(claim: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (typeof claim !== "object" || claim === null) {
    return [{ field: "(claim)", message: "claim must be an object" }];
  }
  const c = claim as Record<string, unknown>;

  // `id` — required string (Hachure: trust-bundle claims require `id`).
  if (typeof c["id"] !== "string" || c["id"].length === 0) {
    issues.push({ field: "id", message: "claim.id must be a non-empty string" });
  }

  // `expiresAt` — optional ISO-8601 date-time string.
  if (c["expiresAt"] !== undefined) {
    if (typeof c["expiresAt"] !== "string" || Number.isNaN(Date.parse(c["expiresAt"]))) {
      issues.push({
        field: "expiresAt",
        message: "claim.expiresAt must be an ISO-8601 date-time string",
      });
    }
  }

  // `ttlSeconds` — optional integer ≥ 0.
  if (c["ttlSeconds"] !== undefined) {
    const ttl = c["ttlSeconds"];
    if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 0) {
      issues.push({
        field: "ttlSeconds",
        message: "claim.ttlSeconds must be an integer >= 0",
      });
    }
  }

  return issues;
}
