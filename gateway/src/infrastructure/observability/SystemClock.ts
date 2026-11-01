import type { Clock } from "../../domain/interfaces/index.js";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

