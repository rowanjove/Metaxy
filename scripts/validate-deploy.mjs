import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const failures = [];
const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const cors = readFileSync(new URL("../cors.json", import.meta.url), "utf8");
const driveCors = readFileSync(new URL("../drive-cors.json", import.meta.url), "utf8");
const galleryCors = readFileSync(new URL("../gallery-cors.json", import.meta.url), "utf8");

if (/00000000-0000-0000-0000-000000000000/.test(wrangler)) {
  failures.push("wrangler.jsonc still contains the placeholder D1 database_id");
}
if (/https:\/\/drop\.example\.com/i.test(cors)) {
  failures.push("cors.json still contains the example production origin");
}
if (/https:\/\/drop\.example\.com/i.test(driveCors)) {
  failures.push("drive-cors.json still contains the example production origin");
}
if (/https:\/\/drop\.example\.com/i.test(galleryCors)) {
  failures.push("gallery-cors.json still contains the example production origin");
}
if (!/\"binding\"\s*:\s*\"DRIVE\"/.test(wrangler)) {
  failures.push("wrangler.jsonc is missing the DRIVE R2 binding");
}
if (!/\"DRIVE_BUCKET_NAME\"\s*:\s*\"[^\"]+\"/.test(wrangler)) {
  failures.push("wrangler.jsonc is missing DRIVE_BUCKET_NAME");
}
if (!/\"binding\"\s*:\s*\"GALLERY\"/.test(wrangler)) {
  failures.push("wrangler.jsonc is missing the GALLERY R2 binding");
}
if (!/\"GALLERY_BUCKET_NAME\"\s*:\s*\"[^\"]+\"/.test(wrangler)) {
  failures.push("wrangler.jsonc is missing GALLERY_BUCKET_NAME");
}

const ttlMatch = wrangler.match(/"PRESIGNED_URL_TTL_SECONDS"\s*:\s*"(\d+)"/);
if (!ttlMatch || Number(ttlMatch[1]) < 1 || Number(ttlMatch[1]) > 300) {
  failures.push("PRESIGNED_URL_TTL_SECONDS must be configured between 1 and 300 seconds");
}

let trackedFiles = [];
try {
  trackedFiles = execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
} catch {
  failures.push("could not inspect tracked files with git ls-files");
}

const secretFilePattern = /(^|\/)(?:\.dev\.vars(?:\..+)?|\.env(?:\..+)?|key(?:\..+)?|credentials?(?:\..+)?)$/i;
const unsafeTracked = trackedFiles.filter((file) => secretFilePattern.test(file)
  && !/\.(?:example|sample)$/i.test(file));
if (unsafeTracked.length > 0) {
  failures.push(`secret-like files are tracked: ${unsafeTracked.join(", ")}`);
}

if (failures.length > 0) {
  console.error("Deployment validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Deployment configuration validation passed.");
}
