import type { GazEntry } from './gaz';
/** One Photon/legacy vocabulary. Icon names are renderer-independent. */
export function searchType(e: Pick<GazEntry, 'cat' | 'type' | 'osm'>): { label: string; icon: 'city' | 'street' | 'address' | 'poi' | 'area' | 'water' } {
  const t = e.type ?? e.cat;
  if (['city','town','village','suburb','neighbourhood','hamlet','country','state'].includes(t)) return { label: t[0].toUpperCase()+t.slice(1), icon: 'city' };
  if (t === 'street') return { label: 'Street', icon: 'street' };
  if (t === 'house' || t === 'address') return { label: 'Address', icon: 'address' };
  if (t === 'water') return { label: 'Water', icon: 'water' };
  if (t === 'area') return { label: 'Area', icon: 'area' };
  const label = (e.osm?.split('/')[1] ?? e.cat ?? 'Place').replace(/_/g,' ');
  return { label: label[0]?.toUpperCase()+label.slice(1), icon: 'poi' };
}
export function searchContext(e: GazEntry, region?: string): string {
  const admin = [e.city,e.state,e.country].filter(Boolean);
  return [searchType(e).label, ...(admin.length ? [...new Set(admin)] : region ? [region] : [])].join(' · ');
}
