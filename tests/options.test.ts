import { describe, expect, it } from "vitest";

import { parseOptions } from "../src/options";

const source = (entry: Record<string, unknown>) => parseOptions({ sources: [entry] }).sources[0];

describe("a source's url", () => {
    it("takes a GeoJSON file on Home Assistant itself without its host", () => {
        expect(source({ type: "geojson", url: "/local/points.geojson" }).url).toBe("/local/points.geojson");
    });

    it("wants a full address for the other types, whose servers are elsewhere", () => {
        expect(() => source({ type: "wms", url: "/local/wms", layer: "rain" })).toThrow();
        expect(source({ type: "wms", url: "https://example.com/wms", layer: "rain" }).url).toBe("https://example.com/wms");
    });

    it("refuses an address that is neither", () => {
        expect(() => source({ type: "geojson", url: "points.geojson" })).toThrow();
    });
});

describe("an error", () => {
    it("names the source and keeps the braces that are part of an XYZ address", () => {
        expect(() => source({ type: "xyz", url: "https://example.com/{z}/{x}/{y}.png" })).toThrow(
            "Invalid source 1. url must be a tile address with {z}, {x} and {y} in it, and the time as {time:YYYYMMDDHHmm}",
        );
    });

    it("lists the choices for a value that isn't one of them", () => {
        expect(() => source({ type: "radar", url: "https://example.com" })).toThrow(/wms, wmts, xyz, rainviewer, geojson, geo_location/);
    });
});

describe("the card's options", () => {
    it("fills in what is left out", () => {
        const options = parseOptions({ sources: [] });
        expect(options).toMatchObject({ zone: "", zoom: 8, regionZoom: 5, mapStyle: "default", mapHeight: 440, speed: 10 });
    });

    it("takes a map no lower than the card can show its bar, chips and some map in", () => {
        expect(() => parseOptions({ sources: [], map_height: 259 })).toThrow();
        expect(parseOptions({ sources: [], map_height: "260" }).mapHeight).toBe(260);
    });

    it("refuses a zone that isn't a zone entity", () => {
        expect(() => parseOptions({ sources: [], zone: "person.someone" })).toThrow();
        expect(parseOptions({ sources: [], zone: "zone.work" }).zone).toBe("zone.work");
    });
});

describe("a source's options", () => {
    it("fills in what is left out, the name from its layer", () => {
        expect(source({ type: "wms", url: "https://example.com/wms", layer: "rain" })).toMatchObject({
            name: "rain",
            historyMinutes: 120,
            opacity: 1,
            staleSteps: 3,
            stepMinutes: 5,
            visibleMinutes: 30,
            legend: null,
            colorScheme: null,
            maxZoom: null,
            timelineMarks: false,
        });
    });

    it("needs a layer for WMS and WMTS, and takes radar for a RainViewer API unless told", () => {
        expect(() => source({ type: "wmts", url: "https://example.com/caps.xml" })).toThrow();
        expect(source({ type: "rainviewer", url: "https://example.com" }).layer).toBe("radar");
        expect(() => source({ type: "rainviewer", url: "https://example.com", layer: "snow" })).toThrow();
    });

    it("reads Home Assistant's own entities for geo_location, with no address", () => {
        expect(source({ type: "geo_location", url: "https://ignored.example.com", source: "blitzortung" })).toMatchObject({
            url: "",
            entitySource: "blitzortung",
            timeAttribute: "publication_date",
        });
    });

    it("takes a legend's address or false, and a colour only in hex", () => {
        const wms = { type: "wms", url: "https://example.com/wms", layer: "rain" };
        expect(source({ ...wms, legend: false }).legend).toBe(false);
        expect(source({ ...wms, legend: "https://example.com/legend.png" }).legend).toBe("https://example.com/legend.png");
        expect(() => source({ ...wms, legend: "legend.png" })).toThrow();
        expect(source({ ...wms, color: "#FFC107" }).color).toBe("#FFC107");
        expect(() => source({ ...wms, color: "yellow" })).toThrow();
    });

    it("refuses an opacity outside 0 to 1 and a visibility of no time", () => {
        expect(() => source({ type: "geojson", url: "/local/a.geojson", opacity: 0 })).toThrow();
        expect(() => source({ type: "geojson", url: "/local/a.geojson", opacity: 1.5 })).toThrow();
        expect(() => source({ type: "geojson", url: "/local/a.geojson", visible_minutes: 0 })).toThrow();
    });
});
