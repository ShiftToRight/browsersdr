import { defineConfig } from "@playwright/test";
import { readFileSync } from "node:fs";
import base from "../playwright.config";

const policy = JSON.parse(
  readFileSync(
    new URL("../scripts/browser-promotion-policy.json", import.meta.url),
    "utf8",
  ),
) as { file: string; title: string }[];
const backslash = String.fromCharCode(92);
const escape = (value: string) =>
  Array.from(value, (character) =>
    ".*+?^${}()|[]".includes(character) || character === backslash
      ? backslash + character
      : character,
  ).join("");

// Original tests, fixtures, deadlines and browser contexts; only selection differs.
export default defineConfig(base, {
  testDir: ".",
  testMatch: [...new Set(policy.map((entry) => entry.file))],
  grep: new RegExp(
    `(?:^| )(?:${policy.map((entry) => escape(entry.title)).join("|")})$`,
  ),
  workers: 1,
  retries: 0,
});
