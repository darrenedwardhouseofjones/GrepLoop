import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const cs = process.env.DATABASE_URL;
const wantsStrictSsl = Boolean(cs.match(/sslmode\s*=\s*(verify-full|verify-ca)/i));
const stripped = cs.replace(/&?sslmode=[^&]*/gi, "").replace(/\?&/, "?").replace(/\?$/, "").replace(/&&/g, "&");
const pool = new Pool({ connectionString: stripped, ssl: wantsStrictSsl ? { rejectUnauthorized: true } : { rejectUnauthorized: false } });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const active = await prisma.reviewRun.findMany({
  where: { status: "in_progress" },
  orderBy: { startedAt: "desc" },
  take: 5,
  select: { id: true, prId: true, startedAt: true, model: true, triggerReason: true, forced: true },
});

console.log("=== ACTIVE SCANS ===");
if (active.length === 0) {
  console.log("  (none)");
} else {
  for (const r of active) {
    const elapsedMs = Date.now() - r.startedAtAt?.getTime?.() ?? (Date.now() - new Date(r.startedAt).getTime());
    const elapsedMin = Math.floor(elapsedMs / 60000);
    const elapsedSec = Math.floor((elapsedMs % 60000) / 1000);
    const logs = await prisma.reviewLog.findMany({
      where: { reviewRunId: r.id },
      orderBy: { createdAt: "desc" },
      take: 3,
      select: { message: true, createdAt: true, level: true },
    });
    console.log(`  ${r.id}`);
    console.log(`    pr: ${r.prId.slice(0, 40)}`);
    console.log(`    model: ${r.model ?? "?"} · trigger: ${r.triggerReason} · forced: ${r.forced}`);
    console.log(`    elapsed: ${elapsedMin}m ${elapsedSec}s`);
    console.log(`    last 3 logs:`);
    for (const l of logs) {
      console.log(`      [${new Date(l.createdAt).toLocaleTimeString()}] ${l.level.padEnd(5)} ${l.message.slice(0, 140)}`);
    }
  }
}

// Also show most-recent-completed for comparison
const lastDone = await prisma.reviewRun.findFirst({
  where: { status: "completed" },
  orderBy: { completedAt: "desc" },
  select: { id: true, startedAt: true, completedAt: true, model: true, rating: true },
});
if (lastDone?.startedAt && lastDone?.completedAt) {
  const durMs = new Date(lastDone.completedAt).getTime() - new Date(lastDone.startedAt).getTime();
  console.log(`\n=== LAST COMPLETED RUN (for comparison) ===`);
  console.log(`  ${lastDone.id}`);
  console.log(`  model: ${lastDone.model} · rating: ${lastDone.rating}`);
  console.log(`  duration: ${Math.floor(durMs/60000)}m ${Math.floor((durMs%60000)/1000)}s`);
}

await pool.end();
