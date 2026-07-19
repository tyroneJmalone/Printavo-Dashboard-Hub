import { mintbucksDb } from "@workspace/mintbucks-db";

type Db = ReturnType<typeof mintbucksDb>;

/**
 * Lazy proxy so ported Mint Bucks code can keep `import { db } from "../db"`
 * semantics while the underlying pool (shared LIVE standalone database) is
 * only created on first use. The api-server boots fine without
 * MINTBUCKS_DATABASE_URL; any mintbucks route hit without it fails loudly.
 */
export const db: Db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    const real = mintbucksDb() as unknown as Record<string | symbol, unknown>;
    const value = Reflect.get(real, prop, receiver);
    return typeof value === "function" ? (value as Function).bind(real) : value;
  },
});
