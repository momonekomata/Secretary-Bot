import type { City } from './store';

/** WMO weather codes used by Open-Meteo. */
const WMO: Record<number, [string, string]> = {
  0: ['☀️', 'Clear sky'],
  1: ['🌤️', 'Mainly clear'],
  2: ['⛅', 'Partly cloudy'],
  3: ['☁️', 'Overcast'],
  45: ['🌫️', 'Fog'],
  48: ['🌫️', 'Freezing fog'],
  51: ['🌦️', 'Light drizzle'],
  53: ['🌦️', 'Drizzle'],
  55: ['🌧️', 'Heavy drizzle'],
  56: ['🌧️', 'Freezing drizzle'],
  57: ['🌧️', 'Heavy freezing drizzle'],
  61: ['🌦️', 'Light rain'],
  63: ['🌧️', 'Rain'],
  65: ['🌧️', 'Heavy rain'],
  66: ['🌧️', 'Freezing rain'],
  67: ['🌧️', 'Heavy freezing rain'],
  71: ['🌨️', 'Light snow'],
  73: ['🌨️', 'Snow'],
  75: ['❄️', 'Heavy snow'],
  77: ['🌨️', 'Snow grains'],
  80: ['🌦️', 'Light showers'],
  81: ['🌧️', 'Showers'],
  82: ['⛈️', 'Violent showers'],
  85: ['🌨️', 'Snow showers'],
  86: ['❄️', 'Heavy snow showers'],
  95: ['⛈️', 'Thunderstorm'],
  96: ['⛈️', 'Thunderstorm with hail'],
  99: ['⛈️', 'Severe thunderstorm with hail'],
};

export function describeCode(code: number): string {
  const [emoji, text] = WMO[code] ?? ['🌡️', `Weather code ${code}`];
  return `${emoji} ${text}`;
}

/** US EPA AQI category with an emoji and short advice. */
export function aqiCategory(aqi: number): { label: string; advice: string } {
  if (aqi <= 50) return { label: '🟢 Good', advice: 'Air is clean; enjoy outdoor activities.' };
  if (aqi <= 100) return { label: '🟡 Moderate', advice: 'Fine for most people; very sensitive people should limit long outdoor exertion.' };
  if (aqi <= 150) return { label: '🟠 Unhealthy for sensitive groups', advice: 'Sensitive groups should wear a mask (N95) outdoors and reduce exertion.' };
  if (aqi <= 200) return { label: '🔴 Unhealthy', advice: 'Wear an N95 mask outside, limit outdoor activity, keep windows closed.' };
  if (aqi <= 300) return { label: '🟣 Very unhealthy', advice: 'Avoid outdoor activity; run an air purifier indoors.' };
  return { label: '🟤 Hazardous', advice: 'Stay indoors with windows closed; avoid all outdoor exertion.' };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo returned ${res.status}`);
  return res.json() as Promise<T>;
}

/** Finds a city by name with Open-Meteo's free geocoding API. */
export async function geocode(name: string): Promise<City | null> {
  const r = await getJson<{ results?: { name: string; country?: string; admin1?: string; latitude: number; longitude: number }[] }>(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`,
  );
  const c = r.results?.[0];
  return c ? { name: c.admin1 && c.admin1 !== c.name ? `${c.name}, ${c.admin1}` : c.name, country: c.country, lat: c.latitude, lon: c.longitude } : null;
}

export interface DayForecast {
  date: string;
  code: number;
  min: number;
  max: number;
  rainChance: number;
  uvMax: number;
}

export interface Forecast {
  current: { temp: number; feelsLike: number; humidity: number; wind: number; code: number };
  days: DayForecast[];
}

export async function forecast(city: City): Promise<Forecast> {
  const r = await getJson<{
    current: Record<string, number>;
    daily: Record<string, (number | string)[]>;
  }>(
    `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}` +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max' +
      '&timezone=auto&forecast_days=7',
  );
  const d = r.daily;
  return {
    current: {
      temp: r.current.temperature_2m,
      feelsLike: r.current.apparent_temperature,
      humidity: r.current.relative_humidity_2m,
      wind: r.current.wind_speed_10m,
      code: r.current.weather_code,
    },
    days: (d.time as string[]).map((date, i) => ({
      date,
      code: Number(d.weather_code[i]),
      min: Number(d.temperature_2m_min[i]),
      max: Number(d.temperature_2m_max[i]),
      rainChance: Number(d.precipitation_probability_max[i] ?? 0),
      uvMax: Number(d.uv_index_max[i] ?? 0),
    })),
  };
}

export interface AirQuality {
  usAqi: number;
  pm25: number;
  pm10: number;
}

export async function airQuality(city: City): Promise<AirQuality> {
  const r = await getJson<{ current: { us_aqi: number; pm2_5: number; pm10: number } }>(
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${city.lat}&longitude=${city.lon}&current=us_aqi,pm2_5,pm10&timezone=auto`,
  );
  return { usAqi: Math.round(r.current.us_aqi), pm25: r.current.pm2_5, pm10: r.current.pm10 };
}

/** The coming Saturday and Sunday (today counts if it is already the weekend). */
export function weekendDays(days: DayForecast[]): DayForecast[] {
  const dow = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCDay();
  const satIdx = days.findIndex((d) => dow(d.date) === 6);
  const sunIdx = days.findIndex((d) => dow(d.date) === 0);
  if (sunIdx === 0) return [days[0]]; // it's Sunday: only today is left
  return [days[satIdx], days[sunIdx]].filter(Boolean);
}

export function formatDay(d: DayForecast): string {
  const weekday = new Date(`${d.date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${weekday}: ${describeCode(d.code)}, ${Math.round(d.min)}–${Math.round(d.max)}°C, rain ${d.rainChance}%, UV max ${d.uvMax.toFixed(0)}`;
}

/** A compact, factual weather + air-quality summary for the AI (or for /weather fallbacks). */
export function formatWeather(city: City, f: Forecast, aq: AirQuality | null, dayCount = 1): string {
  const c = f.current;
  const lines = [
    `Weather for ${city.name}${city.country ? `, ${city.country}` : ''}:`,
    `Now: ${describeCode(c.code)}, ${Math.round(c.temp)}°C (feels like ${Math.round(c.feelsLike)}°C), humidity ${c.humidity}%, wind ${Math.round(c.wind)} km/h.`,
    ...f.days.slice(0, dayCount).map(formatDay),
  ];
  if (aq) {
    const cat = aqiCategory(aq.usAqi);
    lines.push(`Air quality: US AQI ${aq.usAqi} (${cat.label}), PM2.5 ${aq.pm25.toFixed(1)} µg/m³, PM10 ${aq.pm10.toFixed(1)} µg/m³. ${cat.advice}`);
  }
  return lines.join('\n');
}

/** Names a coordinate with OpenStreetMap's Nominatim (free, low volume); falls back to the coordinates. */
export async function reverseGeocode(lat: number, lon: number): Promise<City> {
  const fallback = { name: `${lat.toFixed(3)}, ${lon.toFixed(3)}`, lat, lon };
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=jsonv2&zoom=12&accept-language=en`, {
      headers: { 'User-Agent': 'SecretaryBot/1.0 (personal assistant; https://github.com/momonekomata/Secretary-Bot)' },
    });
    if (!res.ok) return fallback;
    const r = (await res.json()) as { address?: Record<string, string> };
    const a = r.address ?? {};
    const place = a.suburb ?? a.city_district ?? a.town ?? a.city ?? a.village ?? a.county;
    const city = a.city ?? a.town ?? a.state;
    const name = [place, city !== place ? city : undefined].filter(Boolean).join(', ');
    return name ? { name, country: a.country, lat, lon } : fallback;
  } catch {
    return fallback;
  }
}
