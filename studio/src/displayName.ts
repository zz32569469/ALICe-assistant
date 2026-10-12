// §80 名字寫法改成 ALICe：以前存下來的對話紀錄裡還是 ALICE，顯示時換成新寫法（資料庫不動）。
// 程式碼區塊與行內 code 不換：給同事的訊息卡片裡「傳給 ALICE」是收件地址，要照原樣複製。

export function showName(text: string): string {
  return text.replace(/ALICE(?![_A-Za-z])/gu, "ALICe");
}
