import { describe, expect, it } from "vitest";

import { validXyzUrl, xyzFrames, xyzUrl } from "../src/xyz";

const IEM = "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/ridge::USCOMP-N0Q-{time:YYYYMMDDHHmm}/{z}/{x}/{y}.png";
const at = (hours: number, minutes: number, seconds = 0) => Date.UTC(2026, 10, 19, hours, minutes, seconds) / 1000;

describe("validXyzUrl", () => {
    it("takes an address with {z}, {x}, {y} and a time, and nothing short of that", () => {
        expect(validXyzUrl(IEM)).toBe(true);
        expect(validXyzUrl(IEM.replace("{time:YYYYMMDDHHmm}", "202611191200"))).toBe(false);
        expect(validXyzUrl(IEM.replace("{z}", "5"))).toBe(false);
        expect(validXyzUrl(IEM.replace("{time:YYYYMMDDHHmm}", "{time:}"))).toBe(false);
    });
});

describe("xyzFrames", () => {
    it("steps on the clock's whole steps from the newest up to now back over the history", () => {
        expect(xyzFrames(at(12, 7, 30), 300, 0, 1800)).toEqual([
            at(11, 35),
            at(11, 40),
            at(11, 45),
            at(11, 50),
            at(11, 55),
            at(12, 0),
            at(12, 5),
        ]);
    });

    it("ends the delay behind now", () => {
        expect(xyzFrames(at(12, 7, 30), 300, 300, 600).at(-1)).toBe(at(12, 0));
    });

    it("counts the history from the newest frame, so a delay longer than the history still leaves frames", () => {
        expect(xyzFrames(at(12, 7, 30), 300, 3 * 3600, 600)).toEqual([at(8, 55), at(9, 0), at(9, 5)]);
    });
});

describe("xyzUrl", () => {
    it("writes the time in the address's pattern, in UTC", () => {
        expect(xyzUrl(IEM, at(9, 5))).toBe(
            "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/ridge::USCOMP-N0Q-202611190905/{z}/{x}/{y}.png",
        );
    });

    it("takes other patterns and more than one time", () => {
        expect(xyzUrl("https://example.com/{time:YYYY-MM-DD}/{time:HHmmss}/{z}/{x}/{y}.png", at(23, 59, 7))).toBe(
            "https://example.com/2026-11-19/235907/{z}/{x}/{y}.png",
        );
    });
});
