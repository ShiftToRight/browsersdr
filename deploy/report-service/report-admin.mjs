import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { createCommunityStore } from "./report-service.mjs";

const databasePath =
  process.env.BROWSERSDR_REPORT_DB ??
  "/var/lib/browsersdr-reports/reports.sqlite";
const database = new DatabaseSync(databasePath);
const [command = "list", argument, extra] = process.argv.slice(2);

function usage() {
  process.stderr.write(
    "Usage: report-admin.mjs list | show REFERENCE | export REFERENCE FILE | status FINGERPRINT acknowledged|fixed|ignored|needs-information | delete REFERENCE | delete-fingerprint FINGERPRINT | community-list | community-review REFERENCE accepted|excluded|resolved | community-build FILE\n",
  );
  process.exitCode = 2;
}

if (command === "community-list") {
  createCommunityStore(database);
  console.table(
    database
      .prepare(
        "SELECT reference,build_id,feature,result,review,has_issue,received_at FROM community_votes ORDER BY received_at DESC LIMIT 100",
      )
      .all(),
  );
} else if (
  command === "community-review" &&
  argument &&
  ["accepted", "excluded", "resolved"].includes(extra)
) {
  const community = createCommunityStore(database);
  if (!community.review(argument, extra)) {
    process.stderr.write("No current observations found for this reference.\n");
    process.exitCode = 1;
  }
} else if (command === "community-build" && argument) {
  const community = createCommunityStore(database);
  if (!community.registerBuild(JSON.parse(readFileSync(argument, "utf8")))) {
    process.stderr.write("Invalid or conflicting build metadata.\n");
    process.exitCode = 1;
  }
} else if (command === "list") {
  const rows = database
    .prepare(
      "SELECT fingerprint, first_seen, last_seen, count, last_build, last_code, status FROM fingerprint_counts ORDER BY last_seen DESC LIMIT 100",
    )
    .all();
  console.table(rows);
} else if (command === "show" && argument) {
  const row = database
    .prepare(
      "SELECT reference, received_at, fingerprint, build_id, trigger, report_type, status, body FROM reports WHERE reference = ?",
    )
    .get(argument);
  if (!row) {
    process.stderr.write("Report not found.\n");
    process.exitCode = 1;
  } else
    process.stdout.write(
      `${JSON.stringify({ ...row, body: JSON.parse(row.body) }, null, 2)}\n`,
    );
} else if (command === "export" && argument && extra) {
  const row = database
    .prepare("SELECT body FROM reports WHERE reference = ?")
    .get(argument);
  if (!row) {
    process.stderr.write("Report not found.\n");
    process.exitCode = 1;
  } else
    writeFileSync(extra, `${JSON.stringify(JSON.parse(row.body), null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
} else if (
  command === "status" &&
  argument &&
  ["acknowledged", "fixed", "ignored", "needs-information"].includes(extra)
) {
  database
    .prepare("UPDATE fingerprint_counts SET status = ? WHERE fingerprint = ?")
    .run(extra, argument);
  database
    .prepare("UPDATE reports SET status = ? WHERE fingerprint = ?")
    .run(extra, argument);
} else if (command === "delete" && argument) {
  createCommunityStore(database);
  database
    .prepare("DELETE FROM community_votes WHERE reference=?")
    .run(argument);
  database
    .prepare("DELETE FROM community_revisions WHERE reference=?")
    .run(argument);
  database
    .prepare("DELETE FROM community_submissions WHERE reference=?")
    .run(argument);
  database.prepare("DELETE FROM reports WHERE reference = ?").run(argument);
} else if (command === "delete-fingerprint" && argument) {
  createCommunityStore(database);
  for (const table of [
    "community_votes",
    "community_revisions",
    "community_submissions",
  ]) {
    database
      .prepare(
        `DELETE FROM ${table} WHERE reference IN (SELECT reference FROM reports WHERE fingerprint=?)`,
      )
      .run(argument);
  }
  database.prepare("DELETE FROM reports WHERE fingerprint = ?").run(argument);
  database
    .prepare("DELETE FROM fingerprint_counts WHERE fingerprint = ?")
    .run(argument);
} else usage();

database.close();
