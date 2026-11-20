import { describe, expect, it } from "vitest";

import { parseOptions } from "../src/options";
import { advanced, readKey, type LoadedSource } from "../src/sources";

const images = (frames: number[]): LoadedSource => ({
    kind: "images",
    frames,
    step: 300,
    url: () => "",
    legend: null,
    attribution: "",
    maxZoom: null,
});

describe("advanced", () => {
    it("counts the first read, so a source stuck already when the card opens warns only after its steps", () => {
        expect(advanced(null, images([600]))).toBe(true);
    });

    it("moves on with a new newest frame, not with the same one read again", () => {
        expect(advanced(images([300, 600]), images([600, 900]))).toBe(true);
        expect(advanced(images([300, 600]), images([300, 600]))).toBe(false);
    });

    it("moves a feature source on only with its first read, as its chip shows no staleness", () => {
        const features: LoadedSource = { kind: "features", data: { points: [], shapes: [] }, step: 300, legend: null, attribution: "" };
        expect(advanced(null, features)).toBe(true);
        expect(advanced(features, features)).toBe(false);
    });
});

describe("readKey", () => {
    const sources = (entry: Record<string, unknown>) =>
        parseOptions({ sources: [{ type: "wms", url: "https://example.com/wms", layer: "rain", ...entry }] }).sources;
    const plain = readKey(sources({}));

    it("keeps what was read when only how a source is drawn changes", () => {
        for (const change of [
            { name: "Rain" },
            { icon: "mdi:weather-pouring" },
            { opacity: 0.5 },
            { color: "#ffc107" },
            { stale_steps: 9 },
            { visible_minutes: 5 },
            { timeline_marks: true },
        ]) {
            expect(readKey(sources(change))).toBe(plain);
        }
    });

    it("reads again when what is read or how its frames are added changes", () => {
        for (const change of [{ layer: "snow" }, { style: "raster" }, { step_minutes: 10 }, { history_minutes: 60 }, { max_zoom: 8 }]) {
            expect(readKey(sources(change))).not.toBe(plain);
        }
    });
});
