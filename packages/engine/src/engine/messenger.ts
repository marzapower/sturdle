import EventEmitter from "node:events";

import { Logger } from "../logger.js";

type OnParams = Parameters<typeof EventEmitter.prototype.on>;

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Chatter {}

export enum Event {
  JobCompleted = "job:completed",
  JobFailed = "job:failed",
  JobSuspended = "job:suspended",
  JobScheduled = "job:scheduled",
  GracefullyShutdown = "gracefully-shutdown",
  WorkerReady = "worker:ready",
  WorkerJobCompleted = "worker:job-completed",
  WorkerJobFailed = "worker:job-failed",
  WorkerJobSuspended = "worker:job-suspended",
  StoppableStopping = "stoppable:stopping",
  StoppableStopped = "stoppable:stopped",
}

const log = Logger.ns("Sturdle").tagged("Messenger");

export class Messenger extends EventEmitter {
  private static privateInstance: Messenger;
  private static chattersMapping = new Map<Chatter, Map<Event, OnParams[1]>>();

  private constructor() {
    super();
  }

  static get obj() {
    if (!Messenger.privateInstance) {
      Messenger.privateInstance = new Messenger();
      Messenger.privateInstance.setMaxListeners(1000);
    }
    return Messenger.privateInstance;
  }

  static listen(chatter: Chatter, event: Event, listener: OnParams[1]) {
    let chatterMapping = Messenger.chattersMapping.get(chatter);
    if (!chatterMapping) {
      chatterMapping = new Map<Event, OnParams[1]>();
      Messenger.chattersMapping.set(chatter, chatterMapping);
    }

    const listeners = chatterMapping.get(event);
    if (!listeners) {
      chatterMapping.set(event, listener);
    } else {
      log.error(
        "Listener already exists for",
        event,
        "on",
        chatter.constructor.name,
        "- cannot re-subscribe",
      );
      return;
    }

    Messenger.obj.on(event, listener);
  }

  static unlisten(chatter: Chatter, event: Event) {
    const chatterMapping = Messenger.chattersMapping.get(chatter);
    if (chatterMapping) {
      const listener = chatterMapping.get(event);
      if (listener) {
        Messenger.obj.off(event, listener);
      }
      chatterMapping.delete(event);
    }
  }

  static stopListening(chatter: Chatter) {
    const chatterMapping = Messenger.chattersMapping.get(chatter);
    if (chatterMapping) {
      for (const event of chatterMapping.keys()) {
        Messenger.unlisten(chatter, event);
      }
      Messenger.chattersMapping.delete(chatter);
    }
  }

  static emit(event: Event, ...args: unknown[]) {
    Messenger.obj.emit(event, ...args);
  }
}
