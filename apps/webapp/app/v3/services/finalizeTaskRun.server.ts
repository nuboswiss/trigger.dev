import { sanitizeError, TaskRunError } from "@trigger.dev/core/v3";
import { type Prisma, type TaskRun } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";
import { marqs, sanitizeQueueName } from "~/v3/marqs/index.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import {
  FINAL_ATTEMPT_STATUSES,
  isFailedRunStatus,
  isFatalRunStatus,
  type FINAL_RUN_STATUSES,
} from "../taskStatus";
import { PerformTaskRunAlertsService } from "./alerts/performTaskRunAlerts.server";
import { BaseService } from "./baseService.server";
import { ResumeDependentParentsService } from "./resumeDependentParents.server";
import { ExpireEnqueuedRunService } from "./expireEnqueuedRun.server";
import { socketIo } from "../handleSocketIo.server";

type BaseInput = {
  id: string;
  status?: FINAL_RUN_STATUSES;
  expiredAt?: Date;
  completedAt?: Date;
  attemptStatus?: FINAL_ATTEMPT_STATUSES;
  error?: TaskRunError;
};

type InputWithInclude<T extends Prisma.TaskRunInclude> = BaseInput & {
  include: T;
};

type InputWithoutInclude = BaseInput & {
  include?: undefined;
};

type Output<T extends Prisma.TaskRunInclude | undefined> = T extends Prisma.TaskRunInclude
  ? Prisma.TaskRunGetPayload<{ include: T }>
  : TaskRun;

export class FinalizeTaskRunService extends BaseService {
  public async call<T extends Prisma.TaskRunInclude | undefined>({
    id,
    status,
    expiredAt,
    completedAt,
    include,
    attemptStatus,
    error,
  }: T extends Prisma.TaskRunInclude ? InputWithInclude<T> : InputWithoutInclude): Promise<
    Output<T>
  > {
    logger.debug("Finalizing run marqs ack", {
      id,
      status,
      expiredAt,
      completedAt,
    });
    await marqs?.acknowledgeMessage(id);

    logger.debug("Finalizing run updating run status", {
      id,
      status,
      expiredAt,
      completedAt,
    });

    const run = await this._prisma.taskRun.update({
      where: { id },
      data: { status, expiredAt, completedAt },
      ...(include ? { include } : {}),
    });

    if (run.ttl) {
      await ExpireEnqueuedRunService.dequeue(run.id);
    }

    if (attemptStatus || error) {
      await this.finalizeAttempt({ attemptStatus, error, run });
    }

    if (error) {
      await this.finalizeRunError(run, error);
    }

    //resume any dependencies
    const resumeService = new ResumeDependentParentsService(this._prisma);
    const result = await resumeService.call({ id: run.id });

    if (result.success) {
      logger.log("FinalizeTaskRunService: Resumed dependent parents", { result, run });
    } else {
      logger.error("FinalizeTaskRunService: Failed to resume dependent parents", { result, run });
    }

    //enqueue alert
    if (isFailedRunStatus(run.status)) {
      await PerformTaskRunAlertsService.enqueue(run.id, this._prisma);
    }

    if (isFatalRunStatus(run.status)) {
      logger.error("FinalizeTaskRunService: Fatal status", { runId: run.id, status: run.status });

      const extendedRun = await this._prisma.taskRun.findFirst({
        where: { id: run.id },
        select: {
          id: true,
          lockedToVersion: {
            select: {
              supportsLazyAttempts: true,
            },
          },
          runtimeEnvironment: {
            select: {
              type: true,
            },
          },
        },
      });

      if (extendedRun && extendedRun.runtimeEnvironment.type !== "DEVELOPMENT") {
        logger.error("FinalizeTaskRunService: Fatal status, requesting worker exit", {
          runId: run.id,
          status: run.status,
        });

        // Signal to exit any leftover containers
        socketIo.coordinatorNamespace.emit("REQUEST_RUN_CANCELLATION", {
          version: "v1",
          runId: run.id,
          // Give the run a few seconds to exit to complete any flushing etc
          delayInMs: extendedRun.lockedToVersion?.supportsLazyAttempts ? 5_000 : undefined,
        });
      }
    }

    return run as Output<T>;
  }

  async finalizeRunError(run: TaskRun, error: TaskRunError) {
    await this._prisma.taskRun.update({
      where: { id: run.id },
      data: {
        error: sanitizeError(error),
      },
    });
  }

  async finalizeAttempt({
    attemptStatus,
    error,
    run,
  }: {
    attemptStatus?: FINAL_ATTEMPT_STATUSES;
    error?: TaskRunError;
    run: TaskRun;
  }) {
    if (!attemptStatus && !error) {
      logger.error("FinalizeTaskRunService: No attemptStatus or error provided", { runId: run.id });
      return;
    }

    const latestAttempt = await this._prisma.taskRunAttempt.findFirst({
      where: { taskRunId: run.id },
      orderBy: { id: "desc" },
      take: 1,
    });

    if (latestAttempt) {
      logger.debug("Finalizing run attempt", {
        id: latestAttempt.id,
        status: attemptStatus,
        error,
      });

      await this._prisma.taskRunAttempt.update({
        where: { id: latestAttempt.id },
        data: { status: attemptStatus, error: error ? sanitizeError(error) : undefined },
      });

      return;
    }

    // There's no attempt, so create one

    logger.debug("Finalizing run no attempt found", {
      runId: run.id,
      attemptStatus,
      error,
    });

    if (!run.lockedById) {
      logger.error(
        "FinalizeTaskRunService: No lockedById, so can't get the BackgroundWorkerTask. Not creating an attempt.",
        { runId: run.id }
      );
      return;
    }

    const workerTask = await this._prisma.backgroundWorkerTask.findFirst({
      select: {
        id: true,
        workerId: true,
        runtimeEnvironmentId: true,
      },
      where: {
        id: run.lockedById,
      },
    });

    if (!workerTask) {
      logger.error("FinalizeTaskRunService: No worker task found", { runId: run.id });
      return;
    }

    const queue = await this._prisma.taskQueue.findUnique({
      where: {
        runtimeEnvironmentId_name: {
          runtimeEnvironmentId: workerTask.runtimeEnvironmentId,
          name: sanitizeQueueName(run.queue),
        },
      },
    });

    if (!queue) {
      logger.error("FinalizeTaskRunService: No queue found", { runId: run.id });
      return;
    }

    await this._prisma.taskRunAttempt.create({
      data: {
        number: 1,
        friendlyId: generateFriendlyId("attempt"),
        taskRunId: run.id,
        backgroundWorkerId: workerTask?.workerId,
        backgroundWorkerTaskId: workerTask?.id,
        queueId: queue.id,
        runtimeEnvironmentId: workerTask.runtimeEnvironmentId,
        status: attemptStatus,
        error: error ? sanitizeError(error) : undefined,
      },
    });
  }
}
