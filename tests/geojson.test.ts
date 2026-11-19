import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { readGeoJson } from "../src/geojson";

const usgs = () => JSON.parse(readFileSync("tests/fixtures/usgs-earthquakes.json", "utf8")) as unknown;

const collection = (...features: unknown[]) => ({ type: "FeatureCollection", features });
const feature = (geometry: unknown, properties: Record<string, unknown> = {}, id?: string) => ({
    type: "Feature",
    id,
    geometry,
    properties,
});

describe("readGeoJson", () => {
    it("reads USGS's earthquakes as points, their times from milliseconds in `time`", () => {
        const { points, shapes } = readGeoJson(usgs(), "time");
        expect(points).toHaveLength(4);
        expect(shapes).toEqual([]);
        expect(points[0]).toEqual({ key: "ci41363879", position: [expect.any(Number), expect.any(Number)], time: 1795121367, color: "" });
    });

    it("gives no times without a property named for them", () => {
        expect(readGeoJson(usgs(), "").points.every((point) => point.time === null)).toBe(true);
    });

    it("reads times in seconds and in ISO 8601, and none from a value that is neither", () => {
        const { points } = readGeoJson(
            collection(
                feature({ type: "Point", coordinates: [1, 2] }, { at: 1795100000 }),
                feature({ type: "Point", coordinates: [1, 2] }, { at: "2026-11-19T12:00:00Z" }),
                feature({ type: "Point", coordinates: [1, 2] }, { at: "yesterday" }),
            ),
            "at",
        );
        expect(points.map((point) => point.time)).toEqual([1795100000, Date.UTC(2026, 10, 19, 12) / 1000, null]);
    });

    it("splits a MultiPoint into points, and keeps lines and areas as shapes with their properties", () => {
        const area = {
            type: "Polygon",
            coordinates: [
                [
                    [0, 0],
                    [1, 0],
                    [1, 1],
                    [0, 0],
                ],
            ],
        };
        const { points, shapes } = readGeoJson(
            collection(
                feature(
                    {
                        type: "MultiPoint",
                        coordinates: [
                            [1, 2],
                            [3, 4],
                        ],
                    },
                    { "marker-color": "#ff0000" },
                    "pair",
                ),
                feature(area, { fill: "#00ff00", at: 1795100000 }, "zone"),
                feature({
                    type: "LineString",
                    coordinates: [
                        [0, 0],
                        [1, 1],
                    ],
                }),
            ),
            "at",
        );
        expect(points.map((point) => [point.key, point.position, point.color])).toEqual([
            ["pair:0", [1, 2], "#ff0000"],
            ["pair:1", [3, 4], "#ff0000"],
        ]);
        expect(shapes).toHaveLength(2);
        expect(shapes[0]).toEqual({
            time: 1795100000,
            feature: { type: "Feature", geometry: area, properties: { fill: "#00ff00", at: 1795100000 } },
        });
    });

    it("names a feature without an id by its place, and passes over one without a geometry or a position", () => {
        const { points } = readGeoJson(
            collection(feature(null), feature({ type: "Point", coordinates: ["x", 2] }), feature({ type: "Point", coordinates: [5, 6] })),
            "",
        );
        expect(points.map((point) => point.key)).toEqual(["#2"]);
    });

    it("keeps a feature named by its place apart from one whose id is that number", () => {
        const { points } = readGeoJson(
            collection(feature({ type: "Point", coordinates: [1, 2] }, {}, "1"), feature({ type: "Point", coordinates: [3, 4] })),
            "",
        );
        expect(points.map((point) => point.key)).toEqual(["1", "#1"]);
    });

    it("passes over a MultiPoint without a list of positions instead of failing the whole document", () => {
        const { points } = readGeoJson(
            collection(feature({ type: "MultiPoint", coordinates: 5 }), feature({ type: "Point", coordinates: [1, 2] })),
            "",
        );
        expect(points).toHaveLength(1);
    });

    it("reads a single Feature, and refuses what isn't GeoJSON", () => {
        expect(readGeoJson(feature({ type: "Point", coordinates: [1, 2] }), "").points).toHaveLength(1);
        expect(() => readGeoJson({ type: "Point", coordinates: [1, 2] }, "")).toThrow("the answer isn't a GeoJSON feature collection");
        expect(() => readGeoJson([], "")).toThrow("the answer isn't a GeoJSON feature collection");
    });
});
