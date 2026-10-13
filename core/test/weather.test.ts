import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildChatPrompt } from "../src/prompt/promptBuilder.js";
import { describeCode, formatWeatherLine, parseForecast, searchNames, WeatherError, WeatherService, weatherAdvice } from "../src/weather/weatherService.js";

const RAW = {
  current: { time: "2026-10-13T14:15", temperature_2m: 27.4, apparent_temperature: 29.1, relative_humidity_2m: 70, wind_speed_10m: 9.5, weather_code: 2, is_day: 1 },
  hourly: {
    time: Array.from({ length: 48 }, (_, hour) => `2026-10-${13 + Math.floor(hour / 24)}T${String(hour % 24).padStart(2, "0")}:00`),
    temperature_2m: Array.from({ length: 48 }, (_, hour) => 20 + (hour % 24) / 2),
    weather_code: Array.from({ length: 48 }, () => 61),
    precipitation_probability: Array.from({ length: 48 }, () => 40),
  },
  daily: {
    time: ["2026-10-13", "2026-10-14"], weather_code: [61, 0], temperature_2m_max: [29, 31], temperature_2m_min: [20, 24],
    precipitation_probability_max: [60, 10], uv_index_max: [8.5, 5], sunrise: ["2026-10-13T05:48", "2026-10-14T05:49"], sunset: ["2026-10-13T17:30", "2026-10-14T17:29"],
  },
};

// §95：天氣代碼、規則建議、預報整理（從現在這個小時起 12 小時）。
test("weather codes, advice and forecast parsing", () => {
  assert.deepEqual(describeCode(0, false), { label: "晴", icon: "🌙" });
  assert.equal(describeCode(95).label, "雷雨");
  assert.equal(describeCode(1234).label, "未知");
  assert.deepEqual(searchNames("臺北市"), ["Taipei", "臺北市"]);
  assert.deepEqual(searchNames(" 東京 "), ["東京"]);
  assert.deepEqual(searchNames(""), []);

  const advice = weatherAdvice({ max: 29, min: 20, rainChance: 60, uvMax: 8.5, code: 61 });
  assert.deepEqual(advice, ["偏熱：短袖就好", "早晚溫差大（20～29°），穿可以穿脫的", "降雨機率高，記得帶傘", "紫外線很強，做好防曬"]);
  assert.deepEqual(weatherAdvice({ max: 8, min: 4, rainChance: 0, uvMax: 1, code: 3 }), ["很冷：大衣、圍巾都帶上"]);
  assert.match(weatherAdvice({ max: 22, min: 18, rainChance: 10, uvMax: 2, code: 95 }).join("|"), /雷雨/u);

  const forecast = parseForecast(RAW, new Date("2026-10-13T06:15:00Z"));
  assert.equal(forecast.current.label, "多雲");
  assert.equal(forecast.hours.length, 12);
  assert.equal(forecast.hours[0]!.time, "2026-10-13T14:00");
  assert.equal(forecast.days[1]!.label, "晴");
  assert.equal(forecast.days[0]!.rainChance, 60);
  assert.equal(forecast.advice[0], "偏熱：短袖就好");
});

// §95：地點存檔、搜尋、快取 20 分鐘、連不到時的錯誤。
test("WeatherService stores location, caches forecast and reports failures", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-weather-"));
  let now = new Date("2026-10-13T06:00:00Z");
  const calls: string[] = [];
  let fail = false;
  const fetch = async (url: string) => {
    calls.push(url);
    if (fail) throw new Error("offline");
    if (url.includes("geocoding")) return { ok: true, status: 200, json: async () => ({ results: [{ name: "臺北市", latitude: 25.05, longitude: 121.53, country: "臺灣", timezone: "Asia/Taipei", feature_code: "PPLA" }, { name: "機場", latitude: 25.07, longitude: 121.55, feature_code: "AIRP" }, { name: "壞資料" }] }) };
    return { ok: true, status: 200, json: async () => RAW };
  };
  const weather = new WeatherService({ file: join(directory, "weather.json"), fetch, now: () => now });
  try {
    assert.equal(weather.location(), null);
    assert.equal(await weather.forecast(), null);
    assert.deepEqual(await weather.search("  "), []);
    const results = await weather.search("台北");
    assert.equal(results.length, 1);
    assert.match(calls[0]!, /name=Taipei/u);
    assert.match(calls[1]!, /name=%E5%8F%B0%E5%8C%97/u);

    assert.throws(() => weather.setLocation({ name: "x", latitude: 200, longitude: 0 }), (error: unknown) => error instanceof WeatherError && error.kind === "invalid");
    weather.setLocation(results[0]);
    assert.equal(weather.location()!.name, "臺北市");

    await weather.forecast();
    await weather.forecast();
    assert.equal(calls.filter((url) => url.includes("forecast")).length, 1);
    assert.match(calls.at(-1)!, /latitude=25\.05&longitude=121\.53/u);
    now = new Date("2026-10-13T06:25:00Z");
    await weather.forecast();
    assert.equal(calls.filter((url) => url.includes("forecast")).length, 2);
    await weather.forecast(true);
    assert.equal(calls.filter((url) => url.includes("forecast")).length, 3);

    fail = true;
    await assert.rejects(weather.forecast(true), (error: unknown) => error instanceof WeatherError && error.kind === "unavailable");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// §96：聊天提示的一行天氣：只用快取，超過 3 小時在背景重抓；沒有地點不放。
test("weather prompt line uses the cache and refreshes in the background", async () => {
  const forecast = parseForecast(RAW, new Date("2026-10-13T06:15:00Z"));
  const line = formatWeatherLine("臺北市", forecast);
  assert.match(line, /^臺北市（Open-Meteo，\d\d:\d\d 更新）：現在 27° 多雲（體感 29°）；今天 小雨 20～29°、降雨 60%、紫外線 9；明天 晴 24～31°、降雨 10%$/u);

  const directory = mkdtempSync(join(tmpdir(), "alice-weather-line-"));
  let now = new Date("2026-10-13T06:00:00Z");
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => RAW };
  };
  const weather = new WeatherService({ file: join(directory, "weather.json"), fetch, now: () => now });
  try {
    assert.equal(weather.promptLine(), undefined);
    weather.setLocation({ name: "臺北市", latitude: 25.05, longitude: 121.53 });
    assert.equal(weather.promptLine(), undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.match(weather.promptLine()!, /^臺北市/u);
    now = new Date("2026-10-13T10:00:00Z");
    assert.match(weather.promptLine()!, /^臺北市/u);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  const prompt = buildChatPrompt({ personaText: "P", factsText: null, history: [], userText: "要帶傘嗎", state: { mood: "neutral", activity: "idle", updatedAt: "" } as never, justWoken: false, now: new Date(), uploadsDir: directory, weatherLine: line });
  assert.match(prompt.systemPrompt, /# 天氣（主人在天氣分頁設定的地點）\n\n臺北市/u);
  assert.doesNotMatch(buildChatPrompt({ personaText: "P", factsText: null, history: [], userText: "嗨", state: { mood: "neutral", activity: "idle", updatedAt: "" } as never, justWoken: false, now: new Date(), uploadsDir: directory }).systemPrompt, /# 天氣/u);
});
