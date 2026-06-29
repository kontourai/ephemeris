import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getClaimSchema,
  getTrustBundleSchema,
  validateClaimFreshness,
  runIdFromSource,
  EphemerisScheduler,
  ManualClock,
  InMemoryStore,
  RecordingTrigger,
} from "../../dist/index.js";

// Resolve the lazily-loaded schemas once for the assertions below (ops#30).
const claimSchema = getClaimSchema();
const trustBundleSchema = getTrustBundleSchema();

test("read-model is pinned to the published Hachure claim schema", () => {
  // The fields Ephemeris reads must exist in Hachure's claim schema with the
  // types/constraints Ephemeris assumes. This binds the read-model to the
  // published schema so it cannot silently drift.
  assert.equal(
    claimSchema.$id,
    "https://kontourai.io/schemas/surface/claim.schema.json",
    "loaded the real published claim schema",
  );

  // `id` is required.
  assert.ok(claimSchema.required.includes("id"), "claim.id is required in Hachure");

  // `expiresAt` — ISO-8601 date-time string.
  assert.equal(claimSchema.properties.expiresAt.type, "string");
  assert.equal(claimSchema.properties.expiresAt.format, "date-time");

  // `ttlSeconds` — integer >= 0.
  assert.equal(claimSchema.properties.ttlSeconds.type, "integer");
  assert.equal(claimSchema.properties.ttlSeconds.minimum, 0);
});

test("Hachure trust-bundle has no top-level `id`; identity is `source`", () => {
  // This is WHY the read-model keys on `source`, not a bundle id: the published
  // bundle schema actively forbids an `id` (and a few other fields).
  assert.equal(trustBundleSchema.title, "Surface TrustBundle");
  assert.ok(
    Array.isArray(trustBundleSchema.required) &&
      trustBundleSchema.required.includes("source"),
    "trust-bundle requires `source`",
  );
  assert.ok(
    !trustBundleSchema.required.includes("id"),
    "trust-bundle does not require an `id`",
  );
  // The schema's `not.anyOf` clause forbids `id` outright.
  const forbids = trustBundleSchema.not?.anyOf ?? [];
  const forbidsId = forbids.some((c) => (c.required ?? []).includes("id"));
  assert.ok(forbidsId, "the published schema forbids a bundle-level `id`");
});

test("validateClaimFreshness accepts a Hachure-valid claim slice", () => {
  assert.deepEqual(
    validateClaimFreshness({ id: "c1", expiresAt: "2026-06-01T00:00:00.000Z" }),
    [],
  );
  assert.deepEqual(validateClaimFreshness({ id: "c2", ttlSeconds: 3600 }), []);
  assert.deepEqual(validateClaimFreshness({ id: "c3" }), [], "no freshness is valid");
});

test("validateClaimFreshness rejects malformed freshness fields", () => {
  const noId = validateClaimFreshness({ expiresAt: "2026-06-01T00:00:00.000Z" });
  assert.ok(noId.some((i) => i.field === "id"));

  const badExpiry = validateClaimFreshness({ id: "c", expiresAt: "not-a-date" });
  assert.ok(badExpiry.some((i) => i.field === "expiresAt"));

  const badTtl = validateClaimFreshness({ id: "c", ttlSeconds: -1 });
  assert.ok(badTtl.some((i) => i.field === "ttlSeconds"));

  const floatTtl = validateClaimFreshness({ id: "c", ttlSeconds: 1.5 });
  assert.ok(floatTtl.some((i) => i.field === "ttlSeconds"));
});

test("scheduler ingests a real Hachure conformance bundle and arms its claims", async () => {
  // Use Hachure's own conformance vector for the expired/ttl window: it carries
  // the exact claim shape (expiresAt + ttlSeconds) Ephemeris reads. We DO NOT
  // depend on Surface's status derivation — only on the freshness fields.
  const vector = (await import("hachure/conformance/sf-expired-window.json", {
    with: { type: "json" },
  })).default;

  const input = vector.input;
  // Build the read-model from the conformance bundle's claims, stamped with a
  // Flow run-output source label so the runId derives from it cleanly.
  const bundle = {
    source: "flow-run:conformance-flow:run-expired-window",
    claims: input.claims.map((c) => ({
      id: c.id,
      ...(c.expiresAt !== undefined ? { expiresAt: c.expiresAt } : {}),
      ...(c.ttlSeconds !== undefined ? { ttlSeconds: c.ttlSeconds } : {}),
    })),
  };

  // runId derives cleanly from the source label.
  assert.equal(runIdFromSource(bundle.source), "run-expired-window");

  // Drive a ManualClock starting before either deadline so both arm and fire.
  const start = Date.parse("2026-05-01T00:00:00.000Z");
  const clock = new ManualClock(start);
  const trigger = new RecordingTrigger();
  const scheduler = new EphemerisScheduler({
    clock,
    store: new InMemoryStore(),
    trigger,
  });
  await scheduler.start();

  const armed = scheduler.arm(bundle);
  assert.equal(armed.length, 2, "both freshness-bearing conformance claims armed");

  // Advance well past both the expiresAt (2026-06-01) and the 3600s ttl.
  clock.set(Date.parse("2026-07-01T00:00:00.000Z"));
  assert.equal(trigger.fired.length, 2, "both deadlines fired exactly once");
  scheduler.stop();
});
