import { ALICE_BLOCK_MARKERS, AliceBlockFilter } from "./aliceBlockFilter.js";

const START = ALICE_BLOCK_MARKERS.task.start;
const END = ALICE_BLOCK_MARKERS.task.end;

export type TaskBlockFilterResult = {
  visibleText: string;
  blockText?: string;
};

export class TaskBlockFilter {
  readonly #filter: AliceBlockFilter;

  constructor(onDelta: (text: string) => void) {
    this.#filter = new AliceBlockFilter(onDelta);
  }

  push(text: string): void {
    this.#filter.push(text);
  }

  finish(): TaskBlockFilterResult {
    const result = this.#filter.finish();
    return {
      visibleText: result.visibleText,
      ...(result.taskBlockText === undefined ? {} : { blockText: result.taskBlockText }),
    };
  }
}

export const TASK_BLOCK_MARKERS = { start: START, end: END } as const;
