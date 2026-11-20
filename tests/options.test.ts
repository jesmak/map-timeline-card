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
