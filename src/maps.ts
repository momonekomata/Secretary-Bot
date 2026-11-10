/**
 * Google Maps Platform: Places (New) text search and Routes API travel times.
 * Needs GOOGLE_MAPS_API_KEY with both APIs enabled and billing on the Cloud project.
 */
import { t } from './i18n';

export interface Place {
  name: string;
  address: string;
  rating?: number;
  openNow?: boolean;
  link?: string;
}

export interface Route {
  minutes: number;
  km: number;
}

export const TRAVEL_MODES = ['DRIVE', 'WALK', 'BICYCLE', 'TRANSIT', 'TWO_WHEELER'] as const;
export type TravelMode = (typeof TRAVEL_MODES)[number];

export class Maps {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async post<T>(url: string, fieldMask: string, body: unknown): Promise<T> {
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.apiKey, 'X-Goog-FieldMask': fieldMask },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Google Maps ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json() as Promise<T>;
  }

  /** e.g. "ramen near Asok" or "pharmacy open now"; biased towards `near` when given. */
  async searchPlaces(query: string, near?: { lat: number; lon: number }, max = 5): Promise<Place[]> {
    const r = await this.post<{
      places?: { displayName?: { text: string }; formattedAddress?: string; rating?: number; googleMapsUri?: string; currentOpeningHours?: { openNow?: boolean } }[];
    }>(
      'https://places.googleapis.com/v1/places:searchText',
      'places.displayName,places.formattedAddress,places.rating,places.googleMapsUri,places.currentOpeningHours.openNow',
      {
        textQuery: query,
        pageSize: max,
        ...(near ? { locationBias: { circle: { center: { latitude: near.lat, longitude: near.lon }, radius: 20_000 } } } : {}),
      },
    );
    return (r.places ?? []).map((p) => ({
      name: p.displayName?.text ?? '(unnamed)',
      address: p.formattedAddress ?? '',
      rating: p.rating,
      openNow: p.currentOpeningHours?.openNow,
      link: p.googleMapsUri,
    }));
  }

  /** Travel time between two addresses or place names, with live traffic when driving. */
  async route(origin: string, destination: string, mode: TravelMode = 'DRIVE'): Promise<Route | null> {
    const r = await this.post<{ routes?: { duration?: string; distanceMeters?: number }[] }>(
      'https://routes.googleapis.com/directions/v2:computeRoutes',
      'routes.duration,routes.distanceMeters',
      {
        origin: { address: origin },
        destination: { address: destination },
        travelMode: mode,
        ...(mode === 'DRIVE' || mode === 'TWO_WHEELER' ? { routingPreference: 'TRAFFIC_AWARE' } : {}),
      },
    );
    const route = r.routes?.[0];
    if (!route?.duration) return null;
    return { minutes: Math.round(Number(route.duration.replace('s', '')) / 60), km: Math.round((route.distanceMeters ?? 0) / 100) / 10 };
  }
}

export function formatPlaces(places: Place[]): string {
  if (!places.length) return t('No places found.', 'ไม่พบสถานที่');
  const open = t(', open now', ', เปิดอยู่ตอนนี้');
  const closed = t(', closed now', ', ปิดอยู่ตอนนี้');
  return places
    .map((p) => `• ${p.name} — ${p.address}${p.rating ? `, ★${p.rating}` : ''}${p.openNow === undefined ? '' : p.openNow ? open : closed}${p.link ? `\n  ${p.link}` : ''}`)
    .join('\n');
}
