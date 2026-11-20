import { describe, expect, it } from "vitest";

import {
    buildTimeline,
    clock,
    defaultWindow,
    featureSpan,
    frameAt,
    frameFor,
    framesBetween,
    parseDuration,
    parseTime,
    parseTimeDimension,
    stepOf,
} from "../src/time";

const at = (text: string) => parseTime(text)!;

describe("parseDuration", () => {
    it.each([
        ["PT5M", 300],
        ["PT10M", 600],
        ["PT6M", 360],
        ["PT1H", 3600],
        ["P1D", 86400],
        ["P1DT12H", 129600],
        ["PT30S", 30],
        ["PT0.5H", 1800],
        ["PT0M", 0],
        ["PT0H0M", 0],
    ])("reads %s", (text, seconds) => {
        expect(parseDuration(text)).toBe(seconds);
    });

    it.each(["P1M", "P1Y", "PT", "P", "5M", ""])("refuses %s", (text) => {
        expect(parseDuration(text)).toBeNull();
    });
});

describe("parseTime", () => {
    it("reads a time with milliseconds and a zone", () => {
        expect(parseTime("2026-11-19T17:05:00.000Z")).toBe(Date.UTC(2026, 10, 19, 17, 5) / 1000);
    });

    it.each(["2026-11-19T19:05:00+02:00", "2026-11-19T19:05:00+0200", "2026-11-19T12:05:00-05:00"])("reads %s by its zone", (text) => {
        expect(parseTime(text)).toBe(Date.UTC(2026, 10, 19, 17, 5) / 1000);
    });

    it("reads a time without a zone as UTC", () => {
        expect(parseTime("2026-11-19T17:05:00")).toBe(Date.UTC(2026, 10, 19, 17, 5) / 1000);
    });

    it("reads a date alone as its midnight in UTC", () => {
        expect(parseTime("2025-10-22")).toBe(Date.UTC(2025, 9, 22) / 1000);
    });

    it("refuses what isn't a time", () => {
        expect(parseTime("current")).toBeNull();
    });
});

describe("parseTimeDimension", () => {
    it("reads a range with a period, as a radar's capabilities give it", () => {
        expect(parseTimeDimension("2026-11-12T17:15:00.000Z/2026-11-19T17:05:00.000Z/PT5M")).toEqual({
            times: [],
            ranges: [{ start: at("2026-11-12T17:15:00Z"), end: at("2026-11-19T17:05:00Z"), step: 300 }],
        });
    });

    it("reads a list of times and ranges together", () => {
        const extent = parseTimeDimension("2026-11-19T12:10:00Z, 2026-11-19T12:00:00Z,2026-11-19T13:00:00Z/2026-11-19T14:00:00Z/PT30M");
        expect(extent.times).toEqual([at("2026-11-19T12:00:00Z"), at("2026-11-19T12:10:00Z")]);
        expect(extent.ranges).toHaveLength(1);
    });

    it("reads a range without a period, or with a period of zero, as having no steps", () => {
        expect(parseTimeDimension("2026-11-19T12:00Z/2026-11-19T13:00Z").ranges[0].step).toBeNull();
        expect(parseTimeDimension("2026-11-19T12:00Z/2026-11-19T13:00Z/PT0S").ranges[0].step).toBeNull();
        expect(parseTimeDimension("2026-11-19T12:00Z/2026-11-19T13:00Z/P0D").ranges[0].step).toBeNull();
        expect(parseTimeDimension("2026-11-19T12:00Z/2026-11-19T13:00Z/PT0H0M").ranges[0].step).toBeNull();
    });

    it.each(["current", "2026-11-19T13:00Z/2026-11-19T12:00Z", "2026-11-19T12:00Z/2026-11-19T13:00Z/P1M", "a/b/c/d"])(
        "throws on %s",
        (text) => {
            expect(() => parseTimeDimension(text)).toThrow();
        },
    );
});

describe("framesBetween", () => {
    const radar = parseTimeDimension("2026-11-12T17:15:00Z/2026-11-19T17:05:00Z/PT5M");

    it("gives a range's own times within the window, not times between them", () => {
        const frames = framesBetween(radar, at("2026-11-19T16:47:00Z"), at("2026-11-19T17:30:00Z"), 300);
        expect(frames.map((time) => new Date(time * 1000).toISOString().slice(11, 16))).toEqual(["16:50", "16:55", "17:00", "17:05"]);
    });

    it("gives nothing for a window outside the range", () => {
        expect(framesBetween(radar, at("2026-11-20T00:00:00Z"), at("2026-11-20T01:00:00Z"), 300)).toEqual([]);
    });

    it("steps a range without a period back from its end, so its newest time is among them", () => {
        const extent = parseTimeDimension("2026-11-19T12:00Z/2026-11-19T12:12Z");
        const frames = framesBetween(extent, at("2026-11-19T11:00Z"), at("2026-11-19T13:00Z"), 300);
        expect(frames).toEqual([at("2026-11-19T12:02Z"), at("2026-11-19T12:07Z"), at("2026-11-19T12:12Z")]);
    });

    it("starts a range with a period at its own start when the window begins before it", () => {
        const extent = parseTimeDimension("2026-11-19T12:03Z/2026-11-19T12:23Z/PT10M");
        expect(framesBetween(extent, at("2026-11-19T11:00Z"), at("2026-11-19T13:00Z"), 300)).toEqual([
            at("2026-11-19T12:03Z"),
            at("2026-11-19T12:13Z"),
            at("2026-11-19T12:23Z"),
        ]);
    });

    it("cuts a range without a period at the window's end, still stepping from the range's own end", () => {
        const extent = parseTimeDimension("2026-11-19T12:00Z/2026-11-19T12:30Z");
        expect(framesBetween(extent, at("2026-11-19T12:00Z"), at("2026-11-19T12:22Z"), 600)).toEqual([
            at("2026-11-19T12:00Z"),
            at("2026-11-19T12:10Z"),
            at("2026-11-19T12:20Z"),
        ]);
    });

    it("keeps a range's times ahead of now, as a forecast in the same layer gives them", () => {
        const extent = parseTimeDimension("2026-11-16T00:00:00Z/2026-11-19T18:00:00Z/PT5M");
        const frames = framesBetween(extent, at("2026-11-19T17:50:00Z"), Infinity, 300);
        expect(frames).toEqual([at("2026-11-19T17:50:00Z"), at("2026-11-19T17:55:00Z"), at("2026-11-19T18:00:00Z")]);
    });
});

describe("stepOf", () => {
    it("is the period of a range", () => {
        expect(stepOf(parseTimeDimension("2026-11-19T12:00Z/2026-11-19T13:00Z/PT6M"), [], 300)).toBe(360);
    });

    it("is the shortest gap between listed frames", () => {
        expect(stepOf({ times: [], ranges: [] }, [0, 600, 900, 1500], 300)).toBe(300);
    });

    it("falls back when there is nothing to go by", () => {
        expect(stepOf({ times: [], ranges: [] }, [100], 300)).toBe(300);
    });

    it("takes the fallback for a range without a period, even when its frames are further apart", () => {
        expect(stepOf(parseTimeDimension("2026-11-19T12:00Z/2026-11-19T13:00Z"), [0, 900], 420)).toBe(420);
    });

    it("is the shortest of the periods and the gaps together, a period the shortest", () => {
        const extent = parseTimeDimension("2026-11-19T12:00Z/2026-11-19T13:00Z/PT2M,2026-11-19T14:00Z,2026-11-19T14:10Z");
        expect(stepOf(extent, [0, 600, 1200], 300)).toBe(120);
    });
});

describe("frameAt", () => {
    const frames = [100, 200, 300];

    it.each([
        [50, null],
        [100, 100],
        [250, 200],
        [999, 300],
    ])("at %i is %s", (time, frame) => {
        expect(frameAt(frames, time)).toBe(frame);
    });

    it("is null without frames", () => {
        expect(frameAt([], 100)).toBeNull();
    });
});

describe("frameFor", () => {
    const observed = [100, 200, 300];
    const withForecast = [100, 200, 300, 400, 500];

    it("shows an observation-only source's newest frame up to now", () => {
        expect(frameFor(observed, 250, 300)).toBe(200);
        expect(frameFor(observed, 300, 300)).toBe(300);
    });

    it("shows nothing of an observation-only source ahead of now", () => {
        expect(frameFor(observed, 350, 300)).toBeNull();
    });

    it("shows a source with frames ahead in the forecast too, its newest at or before the time", () => {
        expect(frameFor(withForecast, 450, 300)).toBe(400);
    });

    it("keeps a forecast-only source's first frame for the time between now and it", () => {
        expect(frameFor([400, 500], 350, 300)).toBeNull();
        expect(frameFor([400, 500], 420, 300)).toBe(400);
    });
});

describe("buildTimeline", () => {
    it("steps by the shortest step of the sources and spans all of them", () => {
        const timeline = buildTimeline([
            { frames: [3000, 3300, 3600], step: 300 },
            { frames: [3600, 4200, 4800], step: 600 },
        ])!;
        expect(timeline.step).toBe(300);
        expect(timeline.times[0]).toBe(3000);
        expect(timeline.times[timeline.times.length - 1]).toBe(4800);
        expect(timeline.times).toHaveLength(7);
    });

    it("never steps under a minute", () => {
        expect(buildTimeline([{ frames: [0, 10, 20], step: 10 }])!.step).toBe(60);
    });

    it("gives the last frame a time of its own when it falls between steps", () => {
        const timeline = buildTimeline([{ frames: [0, 300, 420], step: 300 }])!;
        expect(timeline.times).toEqual([0, 300, 420]);
    });

    it("leaves sources without frames out, and is null when none has any", () => {
        expect(buildTimeline([{ frames: [], step: 60 }])).toBeNull();
        expect(
            buildTimeline([
                { frames: [], step: 60 },
                { frames: [600], step: 600 },
            ])!.step,
        ).toBe(600);
    });
});

describe("defaultWindow", () => {
    it("is the last hour up to now and everything ahead", () => {
        const timeline = buildTimeline([{ frames: Array.from({ length: 37 }, (_, i) => i * 300), step: 300 }])!;
        expect(defaultWindow(timeline, 24 * 300)).toEqual([12, 36]);
    });

    it("starts at the first frame when there is less than an hour of history", () => {
        const timeline = buildTimeline([{ frames: [0, 300, 600], step: 300 }])!;
        expect(defaultWindow(timeline, 600)).toEqual([0, 2]);
    });

    it("keeps two frames when all of them are older than an hour", () => {
        const timeline = buildTimeline([{ frames: [0, 300, 600], step: 300 }])!;
        expect(defaultWindow(timeline, 99999)).toEqual([1, 2]);
    });
});

describe("clock", () => {
    const noonUtc = at("2026-10-14T12:00:00Z");

    it("shows the time in the zone it is given", () => {
        expect(clock(noonUtc, "fi", "Europe/Helsinki")).toBe("15.00");
        expect(clock(noonUtc, "en-GB", "Asia/Tokyo")).toBe("21:00");
    });
});

describe("featureSpan", () => {
    const now = at("2026-11-20T14:00:00Z");

    it("reaches from the history to now when every feature is in the past", () => {
        expect(featureSpan(now, 7200, [now - 600, now - 60])).toEqual([now - 7200, now]);
        expect(featureSpan(now, 7200, [])).toEqual([now - 7200, now]);
    });

    it("reaches on to the newest feature when it is a forecast", () => {
        expect(featureSpan(now, 7200, [now - 600, now + 4080])).toEqual([now - 7200, now + 4080]);
    });
});
