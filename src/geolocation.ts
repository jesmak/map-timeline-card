/**
 * Home Assistant's geo_location entities as points on the map, each at the moment its time attribute gives, such as a
 * lightning strike's.
 */
import type { HassEntity } from "./hass";
import { parseTime } from "./time";

export interface GeoEvent {
    key: string;
    /** [longitude, latitude]. */
    position: [number, number];
    /** In seconds, or null when the entity has no time, and is shown only live. */
    time: number | null;
}

/** How faint a point is at the end of its visibility, fading to it linearly from its time. */
export const FADED_OPACITY = 0.25;

/**
 * The geo_location entities of a source: all of them, or those whose `source` attribute is `source`. An entity without
 * a position is left out.
 */
export function geoEvents(states: Record<string, HassEntity | undefined>, source: string, timeAttribute: string): GeoEvent[] {
    const events: GeoEvent[] = [];
    for (const [id, state] of Object.entries(states)) {
        if (!id.startsWith("geo_location.") || !state) continue;
        const { latitude, longitude } = state.attributes;
        if (typeof latitude !== "number" || typeof longitude !== "number") continue;
        if (source && state.attributes.source !== source) continue;
        const raw = state.attributes[timeAttribute];
        const time = typeof raw === "string" ? parseTime(raw) : typeof raw === "number" ? raw : null;
        events.push({ key: id, position: [longitude, latitude], time });
    }
    return events;
}

/**
 * How visible an event is at `at`: from 1 at its time down to FADED_OPACITY at the end of `visibleFor` seconds, and 0
 * before its time or after that. An event without a time is shown only live, at full strength.
 */
export function eventOpacity(event: GeoEvent, at: number, visibleFor: number, live: boolean): number {
    if (event.time === null) return live ? 1 : 0;
    const age = at - event.time;
    if (age < 0 || age > visibleFor) return 0;
    return 1 - (1 - FADED_OPACITY) * (visibleFor ? age / visibleFor : 0);
}
