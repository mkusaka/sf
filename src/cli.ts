#!/usr/bin/env node
import { watch } from "chokidar";
import { createLogger } from "./logger.ts";
import { loadWorkflow } from "./workflow.ts";
import { resolveConfig } from "./config.ts";
import { LinearTrackerClient } from "./linear.ts";
import { LocalAgentRunner } from "./agent-runner.ts";
import { Orchestrator } from "./orchestrator.ts";
import { startDashboard, type DashboardServer } from "./server.ts";

type CliArgs = {
  workflowPath: string;
  port: number | null;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const logger = createLogger((process.env.SF_LOG_LEVEL as "debug" | "info" | "warn" | "error" | undefined) ?? "info");
  let workflow = await loadWorkflow(args.workflowPath);
  let config = resolveConfig(workflow);
  if (args.port !== null) config = { ...config, server: { port: args.port } };

  let tracker = new LinearTrackerClient(config.tracker);
  let runner = new LocalAgentRunner({ config, tracker, workflowPrompt: () => workflow.promptTemplate, logger });
  const { SQLiteRuntimeStore } = await import("./persistence.ts");
  const store = new SQLiteRuntimeStore(config.persistence.path);
  const orchestrator = new Orchestrator({ config, tracker, runner, logger, store });
  await orchestrator.start();

  let dashboard: DashboardServer | null = null;
  if (config.server.port !== null) {
    dashboard = await startDashboard(orchestrator, config.server.port);
    logger.info("dashboard started", { url: dashboard.url });
  }

  const watcher = watch(config.workflowPath, { ignoreInitial: true });
  watcher.on("change", async () => {
    try {
      const nextWorkflow = await loadWorkflow(config.workflowPath);
      let nextConfig = resolveConfig(nextWorkflow);
      if (args.port !== null) nextConfig = { ...nextConfig, server: { port: args.port } };
      if (nextConfig.persistence.path !== config.persistence.path) {
        logger.warn("persistence.path changed; restart required for store migration", { current_path: config.persistence.path, next_path: nextConfig.persistence.path });
      }
      const nextTracker = new LinearTrackerClient(nextConfig.tracker);
      const nextRunner = new LocalAgentRunner({ config: nextConfig, tracker: nextTracker, workflowPrompt: () => workflow.promptTemplate, logger });
      await rebindDashboardIfNeeded(dashboard, config.server.port, nextConfig.server.port, orchestrator, logger).then((nextDashboard) => {
        dashboard = nextDashboard;
      });
      workflow = nextWorkflow;
      config = nextConfig;
      tracker = nextTracker;
      runner = nextRunner;
      orchestrator.rebind({ config, tracker, runner });
      logger.info("workflow reloaded", { workflow: workflow.path, poll_interval_ms: config.polling.intervalMs });
    } catch (error) {
      logger.error("workflow reload failed; keeping last known good workflow", { error: error instanceof Error ? error.message : String(error) });
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      logger.info("shutdown requested", { signal });
      orchestrator.stop();
      await dashboard?.close();
      await watcher.close();
      process.exit(0);
    });
  }
}

async function rebindDashboardIfNeeded(
  dashboard: DashboardServer | null,
  currentPort: number | null,
  nextPort: number | null,
  orchestrator: Orchestrator,
  logger: ReturnType<typeof createLogger>
): Promise<DashboardServer | null> {
  if (currentPort === nextPort) return dashboard;
  await dashboard?.close();
  if (nextPort === null) {
    logger.info("dashboard stopped");
    return null;
  }
  const nextDashboard = await startDashboard(orchestrator, nextPort);
  logger.info("dashboard rebound", { url: nextDashboard.url });
  return nextDashboard;
}

function parseArgs(argv: string[]): CliArgs {
  let workflowPath = "./WORKFLOW.md";
  let port: number | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port") {
      const value = argv[index + 1];
      if (!value) throw new Error("--port requires a value");
      port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("--port must be a port number");
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: sf [--port <port>] [path-to-WORKFLOW.md]");
      process.exit(0);
    } else if (!arg?.startsWith("-")) {
      workflowPath = arg ?? workflowPath;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return { workflowPath, port };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
