import { defaultConfig, type Config } from "../config.js";

export type Activity = "idle" | "talking" | "busy" | "sleeping";
export type SleepReason = "idle_timeout" | "night" | "reasoning_unavailable";
export type Energy = "low" | "normal" | "high";

export type State = {
  activity: Activity;
  sleepReason?: SleepReason;
  energy: Energy;
  changedAt: string;
};

export type ReplyResult =
  | { ok: true }
  | {
      ok: false;
      kind: "auth" | "network" | "rate_limited" | "refused" | "other";
    };

export type CharacterStateOptions = {
  now: () => Date;
  config?: Partial<Config>;
};

type StateListener = (state: State) => void;

function minutes(value: number): number {
  return value * 60_000;
}

function minuteOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function parseClock(value: string): number {
  const [hours, minutesPart] = value.split(":").map(Number);
  return hours * 60 + minutesPart;
}

function isInTimeRange(date: Date, start: string, end: string): boolean {
  const current = minuteOfDay(date);
  const startMinute = parseClock(start);
  const endMinute = parseClock(end);
  return startMinute < endMinute
    ? current >= startMinute && current < endMinute
    : current >= startMinute || current < endMinute;
}

export class CharacterState {
  readonly #now: () => Date;
  readonly #config: Config;
  readonly #listeners = new Set<StateListener>();
  #state: State;
  #replying = false;
  #activeTasks = 0;
  #sleepReason: SleepReason | undefined;
  #justWoken = false;
  #retryingReasoningUnavailable = false;
  #consecutiveFailures = 0;
  #lastUserAt: number | undefined;
  #lastReplyEndAt: number | undefined;
  #lastTaskEndAt: number | undefined;
  #continuousTalkStartAt: number | undefined;
  #lastWakeAt: number | undefined;
  readonly #startedAt: number;

  constructor(options: CharacterStateOptions) {
    this.#now = options.now;
    this.#config = { ...defaultConfig, ...options.config };
    const now = this.#now();
    this.#startedAt = now.getTime();
    this.#state = {
      activity: "idle",
      energy: this.#calculateEnergy(now),
      changedAt: now.toISOString(),
    };
  }

  onUserMessage(): void {
    const now = this.#now();
    const nowMs = now.getTime();
    if (
      this.#lastUserAt === undefined ||
      nowMs - this.#lastUserAt >= minutes(this.#config.idleTimeoutMin)
    ) {
      this.#continuousTalkStartAt = nowMs;
    }
    this.#lastUserAt = nowMs;

    if (this.#sleepReason !== undefined) {
      this.#justWoken = true;
      this.#retryingReasoningUnavailable = this.#sleepReason === "reasoning_unavailable";
      this.#sleepReason = undefined;
      this.#lastWakeAt = nowMs;
    }

    this.#replying = true;
    this.#commit(now);
  }

  onReplyEnd(result: ReplyResult): void {
    const now = this.#now();
    this.#replying = false;
    this.#lastReplyEndAt = now.getTime();

    if (result.ok) {
      this.#consecutiveFailures = 0;
      this.#retryingReasoningUnavailable = false;
    } else if (this.#retryingReasoningUnavailable) {
      this.#sleepReason = "reasoning_unavailable";
      this.#retryingReasoningUnavailable = false;
    } else if (result.kind === "auth") {
      this.#sleepReason = "reasoning_unavailable";
    } else if (result.kind === "network" || result.kind === "other") {
      this.#consecutiveFailures += 1;
      if (this.#consecutiveFailures >= this.#config.failuresToSleep) {
        this.#sleepReason = "reasoning_unavailable";
      }
    }

    this.#justWoken = false;
    this.#commit(now);
  }

  onTaskStart(): void {
    const now = this.#now();
    this.#activeTasks += 1;
    if (this.#sleepReason !== undefined) {
      this.#sleepReason = undefined;
      this.#lastWakeAt = now.getTime();
    }
    this.#commit(now);
  }

  onTaskEnd(): void {
    if (this.#activeTasks === 0) {
      return;
    }

    const now = this.#now();
    this.#activeTasks -= 1;
    this.#lastTaskEndAt = now.getTime();
    this.#commit(now);
  }

  tick(): void {
    const now = this.#now();
    if (!this.#replying && this.#activeTasks === 0 && this.#sleepReason === undefined) {
      const idleFor = now.getTime() - this.#idleSince();
      if (
        isInTimeRange(now, this.#config.nightStart, this.#config.nightEnd) &&
        idleFor >= minutes(this.#config.nightIdleMin)
      ) {
        this.#sleepReason = "night";
      } else if (idleFor >= minutes(this.#config.idleTimeoutMin)) {
        this.#sleepReason = "idle_timeout";
      }
    }
    this.#commit(now);
  }

  subscribe(listener: StateListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  getState(): State {
    return { ...this.#state };
  }

  isJustWoken(): boolean {
    return this.#justWoken;
  }

  #idleSince(): number {
    return Math.max(
      this.#startedAt,
      this.#lastUserAt ?? Number.NEGATIVE_INFINITY,
      this.#lastReplyEndAt ?? Number.NEGATIVE_INFINITY,
      this.#lastTaskEndAt ?? Number.NEGATIVE_INFINITY,
    );
  }

  #calculateActivity(): Activity {
    if (this.#replying) {
      return "talking";
    }
    if (this.#activeTasks > 0) {
      return "busy";
    }
    if (this.#sleepReason !== undefined) {
      return "sleeping";
    }
    return "idle";
  }

  #calculateEnergy(now: Date): Energy {
    const nowMs = now.getTime();
    const isLowTime = isInTimeRange(
      now,
      this.#config.energyLowStart,
      this.#config.energyLowEnd,
    );
    const isContinuousTalk =
      this.#continuousTalkStartAt !== undefined &&
      this.#lastUserAt !== undefined &&
      nowMs - this.#lastUserAt < minutes(this.#config.idleTimeoutMin) &&
      nowMs - this.#continuousTalkStartAt > minutes(this.#config.longTalkMin);
    if (isLowTime || isContinuousTalk) {
      return "low";
    }

    if (
      this.#lastWakeAt !== undefined &&
      nowMs - this.#lastWakeAt < minutes(this.#config.energyHighWindowMin)
    ) {
      return "high";
    }
    return "normal";
  }

  #commit(now: Date): void {
    const activity = this.#calculateActivity();
    const energy = this.#calculateEnergy(now);
    const sleepReason = activity === "sleeping" ? this.#sleepReason : undefined;
    if (
      activity === this.#state.activity &&
      energy === this.#state.energy &&
      sleepReason === this.#state.sleepReason
    ) {
      return;
    }

    this.#state = {
      activity,
      ...(sleepReason === undefined ? {} : { sleepReason }),
      energy,
      changedAt: now.toISOString(),
    };
    for (const listener of this.#listeners) {
      listener({ ...this.#state });
    }
  }
}
