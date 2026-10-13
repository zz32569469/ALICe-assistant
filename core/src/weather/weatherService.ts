// §95 天氣（聊天分頁）：用 Open-Meteo（免費、不用金鑰）。地點由主人搜尋城市後選一個，存在 data/weather.json；
// 預報快取 20 分鐘。穿搭與帶傘建議用規則產生，不花 token。

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const CACHE_MS = 20 * 60_000;
const TIMEOUT_MS = 10_000;

/** Open-Meteo 的地名搜尋對中文支援不完整（「台北」找不到、「高雄」先找到四川）：臺灣縣市另外用英文名一起搜。 */
const CITY_ALIASES: Record<string, string> = {
  台北: "Taipei", 臺北: "Taipei", 新北: "New Taipei", 桃園: "Taoyuan", 台中: "Taichung", 臺中: "Taichung", 台南: "Tainan", 臺南: "Tainan",
  高雄: "Kaohsiung", 基隆: "Keelung", 新竹: "Hsinchu", 嘉義: "Chiayi", 宜蘭: "Yilan", 花蓮: "Hualien", 台東: "Taitung", 臺東: "Taitung",
  屏東: "Pingtung", 苗栗: "Miaoli", 彰化: "Changhua", 南投: "Nantou", 雲林: "Yunlin", 澎湖: "Penghu", 金門: "Kinmen", 馬祖: "Matsu",
};

export function searchNames(query: string): string[] {
  const name = query.trim().slice(0, 60);
  if (name === "") return [];
  const key = name.replace(/[市縣]$/u, "");
  const alias = CITY_ALIASES[key];
  return alias === undefined ? [name] : [alias, name];
}

export type WeatherLocation = { name: string; latitude: number; longitude: number; admin1?: string; country?: string; timezone?: string };

export type WeatherDay = {
  date: string; code: number; label: string; icon: string;
  max: number; min: number; rainChance: number | null; uvMax: number | null; sunrise: string | null; sunset: string | null;
};

export type WeatherHour = { time: string; temperature: number; code: number; icon: string; rainChance: number | null };

export type Forecast = {
  fetchedAt: string;
  current: { time: string; temperature: number; feelsLike: number; humidity: number; windSpeed: number; code: number; label: string; icon: string; isDay: boolean };
  hours: WeatherHour[];
  days: WeatherDay[];
  advice: string[];
};

/** invalid：主人給的地點不對；unavailable：天氣服務連不到或回錯誤。 */
export class WeatherError extends Error {
  readonly kind: "invalid" | "unavailable";

  constructor(message: string, kind: "invalid" | "unavailable") {
    super(message);
    this.kind = kind;
  }
}

/** WMO 天氣代碼 → 中文與圖示。 */
export function describeCode(code: number, isDay = true): { label: string; icon: string } {
  if (code === 0) return { label: "晴", icon: isDay ? "☀️" : "🌙" };
  if (code === 1) return { label: "大致晴朗", icon: isDay ? "🌤️" : "🌙" };
  if (code === 2) return { label: "多雲", icon: "⛅" };
  if (code === 3) return { label: "陰", icon: "☁️" };
  if (code === 45 || code === 48) return { label: "霧", icon: "🌫️" };
  if (code >= 51 && code <= 55) return { label: "毛毛雨", icon: "🌦️" };
  if (code === 56 || code === 57) return { label: "凍毛毛雨", icon: "🌧️" };
  if (code === 61) return { label: "小雨", icon: "🌧️" };
  if (code === 63) return { label: "中雨", icon: "🌧️" };
  if (code === 65) return { label: "大雨", icon: "🌧️" };
  if (code === 66 || code === 67) return { label: "凍雨", icon: "🌧️" };
  if (code === 71) return { label: "小雪", icon: "🌨️" };
  if (code === 73) return { label: "中雪", icon: "🌨️" };
  if (code === 75) return { label: "大雪", icon: "❄️" };
  if (code === 77) return { label: "雪粒", icon: "🌨️" };
  if (code >= 80 && code <= 82) return { label: code === 82 ? "強陣雨" : "陣雨", icon: "🌦️" };
  if (code === 85 || code === 86) return { label: "陣雪", icon: "🌨️" };
  if (code === 95) return { label: "雷雨", icon: "⛈️" };
  if (code === 96 || code === 99) return { label: "雷雨夾冰雹", icon: "⛈️" };
  return { label: "未知", icon: "🌡️" };
}

/** 今天的穿搭與提醒（規則，不花 token）。 */
export function weatherAdvice(today: Pick<WeatherDay, "max" | "min" | "rainChance" | "uvMax" | "code">): string[] {
  const advice: string[] = [];
  const max = today.max;
  if (max >= 30) advice.push("很熱：透氣短袖，記得補水");
  else if (max >= 25) advice.push("偏熱：短袖就好");
  else if (max >= 20) advice.push("舒適：短袖，帶件薄外套");
  else if (max >= 15) advice.push("微涼：長袖加外套");
  else if (max >= 10) advice.push("冷：毛衣或厚外套");
  else advice.push("很冷：大衣、圍巾都帶上");
  if (max - today.min >= 8) advice.push(`早晚溫差大（${Math.round(today.min)}～${Math.round(max)}°），穿可以穿脫的`);
  const thunder = today.code >= 95;
  if (thunder) advice.push("可能有雷雨，出門帶傘、注意天氣變化");
  else if ((today.rainChance ?? 0) >= 50) advice.push("降雨機率高，記得帶傘");
  else if ((today.rainChance ?? 0) >= 30) advice.push("可能會下雨，包包放把折傘");
  if ((today.uvMax ?? 0) >= 8) advice.push("紫外線很強，做好防曬");
  else if ((today.uvMax ?? 0) >= 6) advice.push("紫外線偏高，出門擦防曬");
  return advice;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

type RawForecast = {
  current: { time: string; temperature_2m: number; apparent_temperature: number; relative_humidity_2m: number; wind_speed_10m: number; weather_code: number; is_day: number };
  hourly: { time: string[]; temperature_2m: number[]; weather_code: number[]; precipitation_probability?: Array<number | null> };
  daily: {
    time: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[];
    precipitation_probability_max?: Array<number | null>; uv_index_max?: Array<number | null>; sunrise?: string[]; sunset?: string[];
  };
};

/** Open-Meteo 的回應 → 畫面用的資料。hours 從現在這個小時起取 12 小時。 */
export function parseForecast(raw: RawForecast, fetchedAt: Date): Forecast {
  const currentLabel = describeCode(raw.current.weather_code, raw.current.is_day === 1);
  const days: WeatherDay[] = raw.daily.time.map((date, index) => {
    const code = raw.daily.weather_code[index]!;
    return {
      date, code, ...describeCode(code),
      max: raw.daily.temperature_2m_max[index]!, min: raw.daily.temperature_2m_min[index]!,
      rainChance: raw.daily.precipitation_probability_max?.[index] ?? null, uvMax: raw.daily.uv_index_max?.[index] ?? null,
      sunrise: raw.daily.sunrise?.[index] ?? null, sunset: raw.daily.sunset?.[index] ?? null,
    };
  });
  const hourStart = raw.current.time.slice(0, 13);
  const start = Math.max(0, raw.hourly.time.findIndex((time) => time.slice(0, 13) === hourStart));
  const hours: WeatherHour[] = raw.hourly.time.slice(start, start + 12).map((time, offset) => {
    const index = start + offset;
    const code = raw.hourly.weather_code[index]!;
    // 白天或晚上：依當天的日出、日落（沒有資料時用 6～18 點）。
    const day = days.find((entry) => entry.date === time.slice(0, 10));
    const isDay = day?.sunrise && day.sunset ? time >= day.sunrise.slice(0, 13) && time < day.sunset : Number(time.slice(11, 13)) >= 6 && Number(time.slice(11, 13)) < 18;
    return { time, temperature: raw.hourly.temperature_2m[index]!, code, icon: describeCode(code, isDay).icon, rainChance: raw.hourly.precipitation_probability?.[index] ?? null };
  });
  return {
    fetchedAt: fetchedAt.toISOString(),
    current: {
      time: raw.current.time, temperature: raw.current.temperature_2m, feelsLike: raw.current.apparent_temperature,
      humidity: raw.current.relative_humidity_2m, windSpeed: raw.current.wind_speed_10m, code: raw.current.weather_code,
      isDay: raw.current.is_day === 1, ...currentLabel,
    },
    hours,
    days,
    advice: days[0] === undefined ? [] : weatherAdvice(days[0]),
  };
}

/** 一行摘要：現在、今天、之後幾天（每天幾個字，整行約一百字）。 */
export function formatWeatherLine(place: string, forecast: Forecast): string {
  const round = (value: number) => Math.round(value);
  const rain = (value: number | null) => (value === null ? "" : `、降雨 ${value}%`);
  const weekday = (date: string) => {
    const [year, month, day] = date.split("-").map(Number);
    return `週${"日一二三四五六"[new Date(year!, month! - 1, day!).getDay()]}`;
  };
  const days = forecast.days.map((day, index) => {
    const name = index === 0 ? "今天" : index === 1 ? "明天" : `${weekday(day.date)}（${Number(day.date.slice(5, 7))}/${Number(day.date.slice(8, 10))}）`;
    const uv = index === 0 && day.uvMax !== null ? `、紫外線 ${round(day.uvMax)}` : "";
    return `${name} ${day.label} ${round(day.min)}～${round(day.max)}°${rain(day.rainChance)}${uv}`;
  });
  const updated = forecast.fetchedAt === "" ? "" : `，${new Date(forecast.fetchedAt).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false })} 更新`;
  return `${place}（Open-Meteo${updated}）：現在 ${round(forecast.current.temperature)}° ${forecast.current.label}（體感 ${round(forecast.current.feelsLike)}°）；${days.join("；")}`;
}

function validLocation(value: unknown): WeatherLocation | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const text = (key: string, max: number) => (typeof raw[key] === "string" && raw[key] !== "" ? (raw[key] as string).slice(0, max) : undefined);
  const name = text("name", 80);
  const latitude = Number(raw.latitude);
  const longitude = Number(raw.longitude);
  if (name === undefined || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined;
  // Open-Meteo 有些地區名寫成「臺灣省 or 台灣省」，只留第一個。
  const optional = { admin1: text("admin1", 80)?.split(" or ")[0], country: text("country", 80), timezone: text("timezone", 60) };
  return { name, latitude, longitude, ...Object.fromEntries(Object.entries(optional).filter(([, entry]) => entry !== undefined)) };
}

export class WeatherService {
  readonly #file: string;
  readonly #fetch: FetchLike;
  readonly #now: () => Date;
  #cache: { key: string; at: number; forecast: Forecast } | undefined;
  #refreshing = false;

  constructor(options: { file: string; fetch?: FetchLike; now?: () => Date }) {
    this.#file = options.file;
    this.#fetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.#now = options.now ?? (() => new Date());
  }

  location(): WeatherLocation | null {
    if (!existsSync(this.#file)) return null;
    try {
      return validLocation(JSON.parse(readFileSync(this.#file, "utf8"))) ?? null;
    } catch {
      return null;
    }
  }

  /** 存地點；格式不對丟 WeatherError。 */
  setLocation(value: unknown): WeatherLocation {
    const location = validLocation(value);
    if (location === undefined) throw new WeatherError("地點要有名稱與經緯度", "invalid");
    writeFileSync(this.#file, `${JSON.stringify(location, null, 2)}\n`);
    this.#cache = undefined;
    return location;
  }

  /** 搜尋城市：只留有人住的地方（feature_code PPL*），去掉機場、醫院等；同一個點只留一筆。 */
  async search(query: string): Promise<WeatherLocation[]> {
    const results: WeatherLocation[] = [];
    for (const name of searchNames(query)) {
      const url = `${GEOCODE_URL}?name=${encodeURIComponent(name)}&count=10&language=zh&format=json`;
      const body = await this.#get(url) as { results?: Array<Record<string, unknown>> };
      for (const raw of body.results ?? []) {
        if (typeof raw.feature_code === "string" && !raw.feature_code.startsWith("PPL")) continue;
        const location = validLocation(raw);
        if (location === undefined) continue;
        if (results.some((entry) => Math.abs(entry.latitude - location.latitude) < 0.01 && Math.abs(entry.longitude - location.longitude) < 0.01)) continue;
        results.push(location);
      }
    }
    return results.slice(0, 8);
  }

  /** 目前地點的預報（快取 20 分鐘；refresh 強制重抓）。沒設定地點回傳 null。 */
  async forecast(refresh = false): Promise<Forecast | null> {
    const location = this.location();
    if (location === null) return null;
    const key = `${location.latitude},${location.longitude}`;
    const now = this.#now();
    if (!refresh && this.#cache?.key === key && now.getTime() - this.#cache.at < CACHE_MS) return this.#cache.forecast;
    const params = new URLSearchParams({
      latitude: String(location.latitude),
      longitude: String(location.longitude),
      current: "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day",
      hourly: "temperature_2m,weather_code,precipitation_probability",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,sunrise,sunset",
      timezone: "auto",
      forecast_days: "7",
    });
    const forecast = parseForecast(await this.#get(`${FORECAST_URL}?${params.toString()}`) as RawForecast, now);
    this.#cache = { key, at: now.getTime(), forecast };
    return forecast;
  }

  /**
   * §96：給聊天提示的一行天氣摘要（同步，只用快取，不讓回覆等網路）。快取超過 3 小時就在背景重抓，
   * 這次先用舊的（12 小時內）；沒有地點或沒有資料回傳 undefined。
   */
  promptLine(now = this.#now()): string | undefined {
    const location = this.location();
    if (location === null) return undefined;
    const key = `${location.latitude},${location.longitude}`;
    const cache = this.#cache?.key === key ? this.#cache : undefined;
    const age = cache === undefined ? Infinity : now.getTime() - cache.at;
    if (age > 3 * 3_600_000 && !this.#refreshing) {
      this.#refreshing = true;
      void this.forecast(true).catch(() => undefined).finally(() => { this.#refreshing = false; });
    }
    if (cache === undefined || age > 12 * 3_600_000) return undefined;
    return formatWeatherLine(location.name, cache.forecast);
  }

  async #get(url: string): Promise<unknown> {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.#fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new WeatherError(`連不到天氣服務：${error instanceof Error ? error.message : String(error)}`, "unavailable");
    }
    if (!response.ok) throw new WeatherError(`天氣服務回應 HTTP ${response.status}`, "unavailable");
    return response.json();
  }
}
