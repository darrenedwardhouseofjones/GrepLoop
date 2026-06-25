/**
 * Clear persisted findings + review logs for a PR — used between scan
 * iterations when verifying prompt changes. Also marks any in_progress
 * ReviewRun as cancelled so the concurrency guard doesn't trip on
 * abandoned runs.
 *
 * Usage:
 *   set -a && source .env.local && set +a && \
 *     node scripts/clear-pr-findings.mjs <prId>
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const prId = process.argv[2];
if (!prId) {
  console.error("[clear] usage: node scripts/clear-pr-findings.mjs <prId>");
  process.exit(1);
}

const cs = process.env.DATABASE_URL;
const wantsStrictSsl = Boolean(cs.match(/sslmode\s*=\s*(verify-full|verify-ca)/i));
const stripped = cs.replace(/&?sslmode=[^&]*/gi, "").replace(/\?&/, "?").replace(/\?$/, "").replace(/&&/g, "&");
const pool = new Pool({
  connectionString: stripped,
  ssl: wantsStrictSsl ? { rejectUnauthorized: true } : { rejectUnauthorized: false },
});
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const findings = await prisma.reviewFinding.deleteMany({ where: { prId } });
const logs = await prisma.reviewLog.deleteMany({ where: { prId } });
const runs = await prisma.reviewRun.updateMany({
  where: { prId, status: "in_progress" },
  data: { status: "cancelled", completedAt: new Date() },
});

console.log(`[clear] prId=${prId}`);
console.log(`  findings deleted: ${findings.count}`);
console.log(`  logs deleted:     ${logs.count}`);
console.log(`  runs cancelled:   ${runs.count} (in_progress → cancelled)`);

await prisma.$disconnect();
