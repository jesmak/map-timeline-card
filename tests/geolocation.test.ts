import { describe, expect, it } from "vitest";

import { eventOpacity, FADED_OPACITY, geoEvents, type GeoEvent } from "../src/geolocation";
import type { HassEntity } from "../src/hass";

const entity = (id: string, attributes: Record<string, unknown>): HassEntity => ({ entity_id: id, state: "12.3", attributes });

const states: Record<string, HassEntity> = {
    "geo_location.strike_1": entity("geo_location.strike_1", {
        latitude: 61.5,
        longitude: 25.5,
        source: "blitzortung",
        publication_date: "2026-11-19T17:05:00+00:00",
    }),
    "geo_location.quake": entity("geo_location.quake", { latitude: 10, longitude: 20, source: "usgs_earthquakes_feed", time: 1795100000 }),
    "geo_location.no_time": entity("geo_location.no_time", { latitude: 60, longitude: 24, source: "blitzortung" }),
    "geo_location.nowhere": entity("geo_location.nowhere", { source: "blitzortung", publication_date: "2026-11-19T17:05:00Z" }),
    "sensor.strikes": entity("sensor.strikes", { latitude: 1, longitude: 2, source: "blitzortung" }),
};

describe("geoEvents", () => {
    it("picks a source's entities by their source attribute, with their position and time", () => {
        expect(geoEvents(states, "blitzortung", "publication_date")).toEqual([
            { key: "geo_location.strike_1", position: [25.5, 61.5], time: Date.UTC(2026, 10, 19, 17, 5) / 1000 },
            { key: "geo_location.no_time", position: [24, 60], time: null },
        ]);
    });

    it("takes every geo_location entity when no source is given, and never another domain's", () => {
        expect(geoEvents(states, "", "publication_date").map((event) => event.key)).toEqual([
            "geo_location.strike_1",
            "geo_location.quake",
            "geo_location.no_time",
        ]);
    });

    it("reads the time from the attribute set, as seconds too", () => {
        expect(geoEvents(states, "usgs_earthquakes_feed", "time")[0].time).toBe(1795100000);
    });
});

describe("eventOpacity", () => {
    const event: GeoEvent = { key: "a", position: [0, 0], time: 1000 };

    it("is full at the event's time and fades linearly to the faded strength at the end of its visibility", () => {
        expect(eventOpacity(event, 1000, 1800, false)).toBe(1);
        expect(eventOpacity(event, 1900, 1800, false)).toBeCloseTo(1 - (1 - FADED_OPACITY) / 2);
        expect(eventOpacity(event, 2800, 1800, false)).toBeCloseTo(FADED_OPACITY);
    });

    it("is hidden before its time and after its visibility", () => {
        expect(eventOpacity(event, 999, 1800, false)).toBe(0);
        expect(eventOpacity(event, 2801, 1800, false)).toBe(0);
    });

    it("shows an event without a time only live", () => {
        const timeless: GeoEvent = { key: "b", position: [0, 0], time: null };
        expect(eventOpacity(timeless, 5000, 1800, true)).toBe(1);
        expect(eventOpacity(timeless, 5000, 1800, false)).toBe(0);
    });
});
