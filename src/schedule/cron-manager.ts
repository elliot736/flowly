import type { WorkflowStore } from "../store/store.js";
import type { Logger } from "../logger.js";
import { getNextCronDate } from "./cron-parser.js";

export interface CronManagerOptions {
  store: WorkflowStore;
  pollIntervalMs: number;
  log: Logger;
}

export class CronManager {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly log: Logger;
  private readonly opts: CronManagerOptions;

  constructor(opts: CronManagerOptions) {
    this.opts = opts;
    this.log = opts.log;
  }

  start(): void {
    this.running = true;
    this.log.info("cron manager started");
    this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.log.info("cron manager stopped");
  }

  private poll(): void {
    if (!this.running) return;

    this.processDueJobs()
      .catch((err) => {
        this.log.error({ err }, "error processing cron jobs");
      })
      .finally(() => {
        if (this.running) {
          this.timer = setTimeout(
            () => this.poll(),
            this.opts.pollIntervalMs,
          );
        }
      });
  }

  private async processDueJobs(): Promise<void> {
    const now = new Date();
    const dueJobs = await this.opts.store.getDueCronJobs(now);

    if (dueJobs.length > 0) {
      this.log.info({ count: dueJobs.length }, "processing due cron jobs");
    }

    for (const job of dueJobs) {
      try {
        await this.opts.store.createRun({
          workflowName: job.workflowName,
          input: job.input,
        });

        const nextRunAt = getNextCronDate(job.cronExpression, now);
        await this.opts.store.updateCronLastRun(job.id, now, nextRunAt);

        this.log.info(
          { workflow: job.workflowName, nextRunAt },
          "cron job triggered",
        );
      } catch (err) {
        this.log.error(
          { workflow: job.workflowName, cronId: job.id, err },
          "failed to process cron job",
        );
      }
    }
  }
}
