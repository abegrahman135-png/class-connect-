import { randomBytes, randomUUID, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const name = process.argv.slice(2).join(" ").trim() || "Class Teacher";

if (name.length > 60) {
  throw new Error("Teacher name must be at most 60 characters.");
}

const id = randomUUID();
const key = randomBytes(32).toString("hex");
const keyHash = createHash("sha256").update(key).digest("hex");

function sql(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

const statement = `
INSERT INTO users(id, display_name, role, recovery_hash, created_at)
VALUES (
  ${sql(id)},
  ${sql(name)},
  'teacher',
  ${sql(keyHash)},
  ${Date.now()}
);
`;

writeFileSync("teacher-seed.sql", statement, { mode: 0o600 });
writeFileSync(
  "teacher-credentials.txt",
  `Teacher: ${name}\nUser ID: ${id}\nRecovery key: ${key}\n`,
  { mode: 0o600 }
);

console.log(`
Created:
  teacher-seed.sql
  teacher-credentials.txt

Apply teacher-seed.sql to D1, then remove the SQL file.
Store teacher-credentials.txt in a password manager and delete the local copy.
Never commit either file.
`);
