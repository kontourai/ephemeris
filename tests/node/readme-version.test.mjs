import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);

test("README status line does not contradict package.json version", () => {
  const { version } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  const readme = readFileSync(new URL("README.md", root), "utf8");
  const claims = [...readme.matchAll(/^Status:\s*v?(\d+\.\d+(?:\.\d+)?)/gim)].map((m) => m[1]);
  for (const c of claims) {
    assert.ok(version === c || version.startsWith(`${c}.`), `README claims v${c}, package is ${version}`);
  }
});
