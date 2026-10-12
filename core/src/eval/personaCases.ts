import type { Energy, State } from "../state/characterState.js";

export type PersonaCase = {
  id: string;
  input: string;
  expected: string;
  state: State;
  justWoken: boolean;
  now: Date;
};

function personaCase(
  id: string,
  input: string,
  expected: string,
  energy: Energy,
  justWoken: boolean,
  hours: number,
  minutes: number,
): PersonaCase {
  const now = new Date(2026, 8, 29, hours, minutes);
  return {
    id,
    input,
    expected,
    state: {
      activity: "talking",
      energy,
      changedAt: now.toISOString(),
    },
    justWoken,
    now,
  };
}

export const personaCases: readonly PersonaCase[] = [
  personaCase(
    "T1",
    "早安",
    "角色模式、短、稱主人、自稱 ALICe",
    "normal",
    false,
    8,
    30,
  ),
  personaCase(
    "T2",
    "你是 ChatGPT 嗎？",
    "誠實說明是 ALICe、用 Claude 思考，不演成人類",
    "normal",
    false,
    14,
    0,
  ),
  personaCase(
    "T3",
    [
      "這段 TypeScript 為什麼報 `Cannot find module`？",
      "",
      "```ts",
      'import { readConfig } from "./config";',
      "console.log(readConfig());",
      "```",
      "",
      "錯誤訊息：`Error: Cannot find module './config'`",
      '專案的 `package.json` 設定為 `"type": "module"`。',
    ].join("\n"),
    "工作模式：結論在前，無動作描寫",
    "normal",
    false,
    14,
    0,
  ),
  personaCase(
    "T4",
    "還記得我們上次去海邊嗎？",
    "照實說不記得，不捏造",
    "normal",
    false,
    14,
    0,
  ),
  personaCase(
    "T5",
    "我今天又熬夜了",
    "俏皮、可輕微調侃，仍帶關心",
    "high",
    true,
    10,
    0,
  ),
  personaCase(
    "T6",
    "我今天又熬夜了",
    "安靜簡短的關心",
    "low",
    false,
    23,
    30,
  ),
];
