/* eslint-disable @typescript-eslint/no-explicit-any */
import { type EnhancedJob } from "./database/enhanced-job.js";

// ---------------------------------------------------------------------------
// Generic namespaced logger, used across the engine (Logger.ns("Sturdle").tagged("X")).
// ---------------------------------------------------------------------------

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export const logLevelToName: Record<LogLevel, "debug" | "info" | "warn" | "error"> = {
  [LogLevel.DEBUG]: "debug",
  [LogLevel.INFO]: "info",
  [LogLevel.WARN]: "warn",
  [LogLevel.ERROR]: "error",
};

export interface Log {
  level: string;
  message: string;
  timestamp: Date | number;
  step?: string;
  system?: boolean;
  data?: Record<string, unknown>;
  attempt?: number; // 1-based job attempt this log line belongs to; absent on legacy entries
}

export interface LoggerConfig {
  level: LogLevel;
}

export class Logger {
  private config: LoggerConfig;

  constructor(
    private namespace: string,
    private tag?: string,
    config: Partial<LoggerConfig> = {},
  ) {
    this.config = { level: LogLevel.INFO, ...config };
  }

  static ns(namespace: string): Logger {
    return new Logger(namespace);
  }

  tagged(tag: string): Logger {
    return new Logger(this.namespace, tag, this.config);
  }

  configure(config: Partial<LoggerConfig>): this {
    this.config = { ...this.config, ...config };
    return this;
  }

  getConfig(): LoggerConfig {
    return this.config;
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.config.level <= LogLevel.DEBUG) {
      console.debug(this.prefix(), message, ...args);
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (this.config.level <= LogLevel.INFO) {
      console.info(this.prefix(), message, ...args);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.config.level <= LogLevel.WARN) {
      console.warn(this.prefix(), message, ...args);
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (this.config.level <= LogLevel.ERROR) {
      console.error(this.prefix(), message, ...args);
    }
  }

  private prefix(): string {
    return this.tag ? `[${this.namespace}:${this.tag}]` : `[${this.namespace}]`;
  }
}

// ---------------------------------------------------------------------------
// JobLogger: per-job logger that both writes through the generic Logger above and accumulates
// a Log[] trail that gets persisted on the job (EnhancedJob.saveLogs).
// ---------------------------------------------------------------------------

export default class JobLogger {
  private logsArray: Log[];
  private job: EnhancedJob;
  private step?: string;
  private logger: Logger;

  /**
   * Creates a JobLogger.
   *
   * @param job The Job instance this logger refers to
   * @param initialLogs Log lines to seed the logger with, e.g. the entries of the current
   *   attempt already persisted before a resume (from a suspended sleep). New log lines are
   *   appended after these.
   */
  constructor(job: EnhancedJob, initialLogs: Log[] = []) {
    this.job = job;
    this.logsArray = [...initialLogs];
    this.logger = Logger.ns("Sturdle").tagged(`job:${job.id}`);
  }

  bind = (step: string) => {
    this.step = step;
  };

  unbind = () => {
    this.step = undefined;
  };

  currentStep = () => this.step ?? null;

  debug = (...args: any[]) => {
    this.innerLog(LogLevel.DEBUG, false, ...args);
  };

  log = (...args: any[]) => {
    this.innerLog(LogLevel.DEBUG, false, ...args);
  };

  info = (...args: any[]) => {
    this.innerLog(LogLevel.INFO, false, ...args);
  };

  warn = (...args: any[]) => {
    this.innerLog(LogLevel.WARN, false, ...args);
  };

  error = (...args: any[]) => {
    this.innerLog(LogLevel.ERROR, false, ...args);
  };

  get system() {
    return {
      log: (...args: any[]) => this.innerLog(LogLevel.DEBUG, true, ...args),
      debug: (...args: any[]) => this.innerLog(LogLevel.DEBUG, true, ...args),
      info: (...args: any[]) => this.innerLog(LogLevel.INFO, true, ...args),
      warn: (...args: any[]) => this.innerLog(LogLevel.WARN, true, ...args),
      error: (...args: any[]) => this.innerLog(LogLevel.ERROR, true, ...args),
    };
  }

  private innerLog = (level: LogLevel, system: boolean, ...args: any[]) => {
    this.logsArray.push({
      message: args.join(" "),
      timestamp: Date.now(),
      step: this.step,
      level: logLevelToName[level],
      system,
      attempt: this.job.attempts,
    });

    if (this.logger.getConfig().level <= level) {
      // Use the underlying system logger to maintain consistent formatting
      const logMethod = this.logger[logLevelToName[level]];
      if (typeof logMethod === "function") {
        const [message, ...rest] = args;
        const method = logMethod as (message: string, ...args: unknown[]) => void;
        method.call(this.logger, String(message ?? ""), ...rest);
      }
    }
  };

  logs = () => this.logsArray;
}
