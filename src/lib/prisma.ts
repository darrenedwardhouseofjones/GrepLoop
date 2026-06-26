import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const globalForPrisma = globalThis as unknown & {
  __prismaPool?: Pool;
  __prisma?: PrismaClient;
};

if (!globalForPrisma.__prismaPool) {
  const cs =
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5432/postgres";
  const wantsStrictSsl = Boolean(
    cs.match(/sslmode\s*=\s*(verify-full|verify-ca)/i),
  );
  // Local Postgres (dev container, system cluster, embedded) doesn't speak
  // TLS by default — handing pg an `ssl: {}` object makes it try STARTTLS
  // and fail with "server does not support SSL". Detect:
  //   1. explicit `sslmode=disable` in the URL, OR
  //   2. host is loopback / localhost / *.local
  // and pass `ssl: false` so pg opens a plain TCP connection.
  const wantsNoSsl =
    Boolean(cs.match(/sslmode\s*=\s*(disable|allow|prefer)/i)) ||
    Boolean(
      cs.match(
        /@(localhost|127\.[\d.]+|::1|\[::1\]|[a-z0-9.-]+\.local)(:\d+)?\//i,
      ),
    );
  const stripped = cs
    .replace(/&?sslmode=[^&]*/gi, "")
    .replace(/\?&/, "?")
    .replace(/\?$/, "")
    .replace(/&&/g, "&");
  globalForPrisma.__prismaPool = new Pool({
    connectionString: stripped,
    ssl: wantsNoSsl
      ? false
      : wantsStrictSsl
        ? { rejectUnauthorized: true }
        : { rejectUnauthorized: false },
  });
}

if (!globalForPrisma.__prisma) {
  const adapter = new PrismaPg(globalForPrisma.__prismaPool);
  globalForPrisma.__prisma = new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.__prisma;
export const pool = globalForPrisma.__prismaPool;
