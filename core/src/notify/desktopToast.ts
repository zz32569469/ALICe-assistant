// §74 Windows 桌面通知：用系統內建的 Windows PowerShell 跳出通知（不用另外安裝）。
// 標題與內文從環境變數傳，不拼進指令；失敗只回傳錯誤訊息，不影響 Core。

import { execFile } from "node:child_process";

const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
  "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$texts = $xml.GetElementsByTagName('text')",
  "$texts.Item(0).AppendChild($xml.CreateTextNode($env:ALICE_TOAST_TITLE)) > $null",
  "$texts.Item(1).AppendChild($xml.CreateTextNode($env:ALICE_TOAST_BODY)) > $null",
  "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)",
].join("; ");

export type DesktopNotifier = (title: string, body: string) => Promise<string | null>;

/** 跳一則 Windows 通知；不是 Windows 時什麼都不做。回傳 null 表示成功，否則是錯誤訊息。 */
export const showDesktopToast: DesktopNotifier = (title, body) => {
  if (process.platform !== "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT],
      { env: { ...process.env, ALICE_TOAST_TITLE: title, ALICE_TOAST_BODY: body }, windowsHide: true, timeout: 15_000 },
      (error, _stdout, stderr) => resolve(error === null ? null : (stderr.trim() || error.message).split(/\r?\n/u)[0]!),
    );
  });
};
