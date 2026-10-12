// 安全的小型 Markdown 顯示：直接產生 Vue 節點（文字一律是文字節點，不用 v-html），
// 支援艾莉絲與報告常用的語法：標題、段落、條列、表格、程式碼區塊、引用、**粗體**、`程式碼`。

import { defineComponent, h, type VNode } from "vue";

import { showName } from "../displayName";

function inline(text: string): Array<VNode | string> {
  const nodes: Array<VNode | string> = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/gu;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(showName(text.slice(last, index)));
    const token = match[0];
    nodes.push(token.startsWith("**") ? h("strong", showName(token.slice(2, -2))) : h("code", token.slice(1, -1)));
    last = index + token.length;
  }
  if (last < text.length) nodes.push(showName(text.slice(last)));
  return nodes;
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
}

function render(text: string): VNode[] {
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  const blocks: VNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const fence = /^(\s*)(```+|~~~+)/u.exec(line);
    if (fence !== null) {
      const marker = fence[2]!;
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.trim().startsWith(marker)) body.push(lines[index++]!);
      index += 1;
      blocks.push(h("pre", h("code", body.join("\n"))));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
    if (heading !== null) {
      blocks.push(h(`h${Math.min(6, heading[1]!.length + 2)}`, inline(heading[2]!)));
      index += 1;
      continue;
    }
    if (/^\s*\|.*\|\s*$/u.test(line) && /^\s*\|?\s*:?-{3,}/u.test(lines[index + 1] ?? "")) {
      const header = splitRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/u.test(lines[index]!)) rows.push(splitRow(lines[index++]!));
      blocks.push(h("div", { class: "md-table" }, h("table", [
        h("thead", h("tr", header.map((cell) => h("th", inline(cell))))),
        h("tbody", rows.map((row) => h("tr", row.map((cell) => h("td", inline(cell)))))),
      ])));
      continue;
    }
    if (/^\s*>/u.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>/u.test(lines[index]!)) quoted.push(lines[index++]!.replace(/^\s*>\s?/u, ""));
      blocks.push(h("blockquote", render(quoted.join("\n"))));
      continue;
    }
    const listItem = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/u;
    if (listItem.test(line)) {
      const ordered = /^\s*\d/u.test(line);
      const items: VNode[] = [];
      while (index < lines.length && listItem.test(lines[index]!)) {
        const match = listItem.exec(lines[index]!)!;
        const nested = match[1]!.length >= 2;
        items.push(h("li", nested ? { class: "nested" } : {}, inline(match[3]!)));
        index += 1;
      }
      blocks.push(h(ordered ? "ol" : "ul", items));
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index]!.trim() !== "" && !/^(#{1,6}\s|\s*```|\s*>|\s*([-*•]|\d+[.)])\s)/u.test(lines[index]!)
      && !(/^\s*\|.*\|\s*$/u.test(lines[index]!) && paragraph.length === 0)) {
      paragraph.push(lines[index++]!);
    }
    if (paragraph.length === 0) {
      blocks.push(h("p", inline(lines[index++]!)));
      continue;
    }
    const children: Array<VNode | string> = [];
    paragraph.forEach((part, partIndex) => {
      if (partIndex > 0) children.push(h("br"));
      children.push(...inline(part));
    });
    blocks.push(h("p", children));
  }
  return blocks;
}

export default defineComponent({
  name: "MarkdownText",
  props: { text: { type: String, required: true } },
  setup(props) {
    return () => h("div", { class: "md" }, render(props.text));
  },
});
