import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const cs = process.env.DATABASE_URL;
const wantsStrictSsl = Boolean(cs.match(/sslmode\s*=\s*(verify-full|verify-ca)/i));
const stripped = cs.replace(/&?sslmode=[^&]*/gi, "").replace(/\?&/, "?").replace(/\?$/, "").replace(/&&/g, "&");
const pool = new Pool({ connectionString: stripped, ssl: wantsStrictSsl ? { rejectUnauthorized: true } : { rejectUnauthorized: false } });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const runId = process.argv[2];
const logs = await prisma.reviewLog.findMany({
  where: { reviewRunId: runId },
  orderBy: { createdAt: "asc" },
  select: { message: true, level: true, createdAt: true }
});
console.log(`=== LOGS (${logs.length}) ===`);
logs.forEach((l, i) => console.log(`  [${i+1}] ${l.level.padEnd(5)} ${l.message.slice(0, 200)}`));

const findings = await prisma.reviewFinding.findMany({
  where: { reviewRunId: runId },
  select: { filename: true, source: true, severity: true, verificationStatus: true }
});
console.log(`\n=== FINDINGS (${findings.length}) ===`);
const bySource = findings.reduce((acc, f) => { acc[f.source ?? "null"] = (acc[f.source ?? "null"] ?? 0) + 1; return acc; }, {});
console.log("by source:", bySource);
findings.slice(0, 15).forEach(f => console.log(`  [${f.source ?? "null"}] ${f.verificationStatus ?? "?"} ${f.severity.padEnd(10)} ${f.filename}`));

await pool.end();
