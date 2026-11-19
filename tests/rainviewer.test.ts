import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { catalogueUrl, readCatalogue } from "../src/rainviewer";

const fixture = (name: string): unknown => JSON.parse(readFileSync(`tests/fixtures/${name}.json`, "utf8"));
const librewxr = fixture("librewxr-catalogue") as {
    host: string;
    radar: { past: { time: number; path: string }[]; nowcast: { time: number; path: string }[] };
    satellite: { infrared: { time: number; path: string }[] };
};

describe("readCatalogue", () => {
    it("gives LibreWXR's radar frames, past and forecast, oldest first", () => {
        const catalogue = readCatalogue(librewxr, "radar", null);
        const expected = [...librewxr.radar.past, ...librewxr.radar.nowcast].map((frame) => frame.time);
        expect(catalogue.frames).toEqual(expected);
        expect(catalogue.frames).toEqual([...catalogue.frames].sort((a, b) => a - b));
    });

    it("draws the radar in the first scheme the server lists unless told another", () => {
        expect(readCatalogue(librewxr, "radar", null).scheme).toBe(0);
        const frame = librewxr.radar.nowcast[0];
        expect(readCatalogue(librewxr, "radar", 4).url(frame.time)).toBe(`${librewxr.host}${frame.path}/256/{z}/{x}/{y}/4/1_1.png`);
    });

    it("refuses a scheme the server doesn't list, naming those it does", () => {
        expect(() => readCatalogue(librewxr, "radar", 99)).toThrow(/no colour scheme 99, only 0, 1, 2/);
    });

    it("takes any scheme from a server that lists none, and 0 unless told another", () => {
        const rainviewer = fixture("rainviewer-catalogue");
        expect(readCatalogue(rainviewer, "radar", null).scheme).toBe(0);
        expect(readCatalogue(rainviewer, "radar", 2).scheme).toBe(2);
    });

    it("gives the tiles under the catalogue's own host, which may differ from the server's", () => {
        const rainviewer = fixture("rainviewer-catalogue") as { host: string; radar: { past: { time: number; path: string }[] } };
        const frame = rainviewer.radar.past[0];
        expect(readCatalogue(rainviewer, "radar", null).url(frame.time)).toBe(`${rainviewer.host}${frame.path}/256/{z}/{x}/{y}/0/1_1.png`);
    });

    it("gives the satellite's frames in the one look they have", () => {
        const catalogue = readCatalogue(librewxr, "satellite", 4);
        const frame = librewxr.satellite.infrared[0];
        expect(catalogue.frames).toHaveLength(librewxr.satellite.infrared.length);
        expect(catalogue.url(frame.time)).toBe(`${librewxr.host}${frame.path}/256/{z}/{x}/{y}/0/0_0.png`);
        expect(catalogue.scheme).toBeNull();
    });

    it("skips a frame without a time or a path", () => {
        const catalogue = readCatalogue(
            { host: "https://example.com", radar: { past: [{ time: 600, path: "/v2/radar/600" }, { time: 1200 }, { path: "/x" }] } },
            "radar",
            null,
        );
        expect(catalogue.frames).toEqual([600]);
    });

    it.each([null, [], { radar: {} }, { host: "example.com", radar: {} }])("refuses %j as a catalogue", (json) => {
        expect(() => readCatalogue(json, "radar", null)).toThrow("isn't a RainViewer API catalogue");
    });
});

describe("catalogueUrl", () => {
    it.each(["https://api.example.com", "https://api.example.com/"])("finds the catalogue under %s", (server) => {
        expect(catalogueUrl(server)).toBe("https://api.example.com/public/weather-maps.json");
    });
});
