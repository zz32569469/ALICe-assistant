const MARKERS = {
  task: { start: "<<<ALICE_TASK", end: "ALICE_TASK>>>" },
  ask: { start: "<<<ALICE_ASK", end: "ALICE_ASK>>>" },
  plan: { start: "<<<ALICE_PLAN", end: "ALICE_PLAN>>>" },
  suggest: { start: "<<<ALICE_SUGGEST", end: "ALICE_SUGGEST>>>" },
  send: { start: "<<<ALICE_SEND", end: "ALICE_SEND>>>" },
  game: { start: "<<<ALICE_GAME", end: "ALICE_GAME>>>" },
  progress: { start: "<<<ALICE_PROGRESS", end: "ALICE_PROGRESS>>>" },
  doc: { start: "<<<ALICE_DOC", end: "ALICE_DOC>>>" },
  meeting: { start: "<<<ALICE_MEETING", end: "ALICE_MEETING>>>" },
  memory: { start: "<<<ALICE_MEMORY", end: "ALICE_MEMORY>>>" },
} as const;

export type AliceBlockKind = keyof typeof MARKERS;

export type AliceBlockFilterResult = {
  visibleText: string;
  taskBlockText?: string;
  askBlockText?: string;
  planBlockText?: string;
  suggestBlockText?: string;
  sendBlockTexts?: string[];
  /** 專案卡區塊可以有多個（§30）。 */
  gameBlockTexts?: string[];
  progressBlockText?: string;
  /** 文件區塊可以有多個（§45）。 */
  docBlockTexts?: string[];
  /** §74 會議區塊可以有多個。 */
  meetingBlockTexts?: string[];
  /** §85 記憶區塊可以有多個。 */
  memoryBlockTexts?: string[];
};

function heldPrefixLength(value: string): number {
  let longest = 0;
  for (const marker of Object.values(MARKERS)) {
    const maximum = Math.min(value.length, marker.start.length - 1);
    for (let length = maximum; length > longest; length -= 1) {
      if (value.endsWith(marker.start.slice(0, length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}

export class AliceBlockFilter {
  readonly #onDelta: (text: string) => void;
  readonly #blocks: Partial<Record<AliceBlockKind, string>> = {};
  /** 傳訊區塊可以有多個（一次問好幾位同事，§27）。 */
  readonly #sends: string[] = [];
  readonly #games: string[] = [];
  readonly #docs: string[] = [];
  readonly #meetings: string[] = [];
  readonly #memories: string[] = [];
  #pending = "";
  #visible = "";
  #capturing: AliceBlockKind | undefined;

  constructor(onDelta: (text: string) => void) {
    this.#onDelta = onDelta;
  }

  push(text: string): void {
    this.#pending += text;
    this.#consume(false);
  }

  finish(): AliceBlockFilterResult {
    this.#consume(true);
    return {
      visibleText: this.#visible,
      ...(this.#blocks.task === undefined ? {} : { taskBlockText: this.#blocks.task }),
      ...(this.#blocks.ask === undefined ? {} : { askBlockText: this.#blocks.ask }),
      ...(this.#blocks.plan === undefined ? {} : { planBlockText: this.#blocks.plan }),
      ...(this.#blocks.suggest === undefined ? {} : { suggestBlockText: this.#blocks.suggest }),
      ...(this.#sends.length === 0 ? {} : { sendBlockTexts: [...this.#sends] }),
      ...(this.#games.length === 0 ? {} : { gameBlockTexts: [...this.#games] }),
      ...(this.#blocks.progress === undefined ? {} : { progressBlockText: this.#blocks.progress }),
      ...(this.#docs.length === 0 ? {} : { docBlockTexts: [...this.#docs] }),
      ...(this.#meetings.length === 0 ? {} : { meetingBlockTexts: [...this.#meetings] }),
      ...(this.#memories.length === 0 ? {} : { memoryBlockTexts: [...this.#memories] }),
    };
  }

  #consume(finishing: boolean): void {
    for (;;) {
      if (this.#capturing !== undefined) {
        const marker = MARKERS[this.#capturing];
        const endAt = this.#pending.indexOf(marker.end, marker.start.length);
        if (endAt < 0) {
          if (finishing && this.#pending !== "") this.#saveBlock(this.#capturing, this.#pending);
          return;
        }
        const blockEnd = endAt + marker.end.length;
        this.#saveBlock(this.#capturing, this.#pending.slice(0, blockEnd));
        this.#pending = this.#pending.slice(blockEnd);
        this.#capturing = undefined;
        continue;
      }

      const found = (Object.entries(MARKERS) as Array<[AliceBlockKind, typeof MARKERS[AliceBlockKind]]>)
        .map(([kind, marker]) => ({ kind, at: this.#pending.indexOf(marker.start) }))
        .filter((candidate) => candidate.at >= 0)
        .sort((left, right) => left.at - right.at)[0];
      if (found !== undefined) {
        this.#emit(this.#pending.slice(0, found.at));
        this.#pending = this.#pending.slice(found.at);
        this.#capturing = found.kind;
        continue;
      }

      const held = finishing ? 0 : heldPrefixLength(this.#pending);
      const safeLength = this.#pending.length - held;
      this.#emit(this.#pending.slice(0, safeLength));
      this.#pending = this.#pending.slice(safeLength);
      return;
    }
  }

  #saveBlock(kind: AliceBlockKind, text: string): void {
    if (kind === "send") {
      this.#sends.push(text);
      return;
    }
    if (kind === "game") {
      this.#games.push(text);
      return;
    }
    if (kind === "memory") {
      this.#memories.push(text);
      return;
    }
    if (kind === "meeting") {
      this.#meetings.push(text);
      return;
    }
    if (kind === "doc") {
      this.#docs.push(text);
      return;
    }
    if (this.#blocks[kind] === undefined) this.#blocks[kind] = text;
    else console.warn(`A second ALICE_${kind.toUpperCase()} block was ignored`);
  }

  #emit(text: string): void {
    if (text === "") return;
    this.#visible += text;
    this.#onDelta(text);
  }
}

export const ALICE_BLOCK_MARKERS = MARKERS;

