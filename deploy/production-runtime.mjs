import { dirname } from "node:path";
import { Miniflare } from "miniflare";
import { unstable_getMiniflareWorkerOptions } from "wrangler";

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 3000);
const configPath =
  process.env.NQ_WRANGLER_CONFIG || "/app/dist/server/wrangler.json";
const persistRoot =
  process.env.NQ_MINIFLARE_PERSIST_ROOT ||
  "/var/lib/nexus-quant/wrangler/state/v3/v3";
const envFile = process.env.NQ_RUNTIME_ENV_FILE || "/app/.runtime.env";

const { workerOptions, main, externalWorkers } =
  unstable_getMiniflareWorkerOptions(configPath, undefined, {
    // Wrangler's public type currently omits envFiles, but its runtime API
    // accepts the same env-file list used by `wrangler dev`.
    envFiles: [envFile],
  });

if (!main) {
  throw new Error("Production Worker entrypoint is missing");
}

const runtime = new Miniflare({
  host,
  port,
  defaultPersistRoot: persistRoot,
  workers: [
    {
      name: "nexus-quant-contract-trader",
      ...workerOptions,
      modules: true,
      scriptPath: main,
      modulesRoot: dirname(main),
    },
    ...externalWorkers,
  ],
});

let stopping = false;

async function stop(signal, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  try {
    await runtime.dispose();
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        service: "production-runtime",
        code: "RUNTIME_DISPOSE_FAILED",
        signal,
        message: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
      }),
    );
    exitCode = 1;
  }
  process.exit(exitCode);
}

try {
  const address = await runtime.ready;
  console.info(
    JSON.stringify({
      level: "info",
      service: "production-runtime",
      code: "RUNTIME_READY",
      address: address.origin,
      at: new Date().toISOString(),
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      level: "error",
      service: "production-runtime",
      code: "RUNTIME_START_FAILED",
      message: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
    }),
  );
  await runtime.dispose().catch(() => undefined);
  process.exit(1);
}

process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
process.on("uncaughtException", (error) => {
  console.error(
    JSON.stringify({
      level: "error",
      service: "production-runtime",
      code: "UNCAUGHT_EXCEPTION",
      message: error.message,
      at: new Date().toISOString(),
    }),
  );
  void stop("UNCAUGHT_EXCEPTION", 1);
});
process.on("unhandledRejection", (reason) => {
  console.error(
    JSON.stringify({
      level: "error",
      service: "production-runtime",
      code: "UNHANDLED_REJECTION",
      message: reason instanceof Error ? reason.message : String(reason),
      at: new Date().toISOString(),
    }),
  );
  void stop("UNHANDLED_REJECTION", 1);
});
