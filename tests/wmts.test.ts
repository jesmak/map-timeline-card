import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { readWmtsCapabilities } from "../src/wmts";

// As in wms.test.ts: read from the repo's root, the XML declaration taken off for happy-dom.
const fixture = (name: string) => readFileSync(`tests/fixtures/${name}.xml`, "utf8").replace(/^<\?xml[^>]*\?>/, "");

const GOES = "GOES-East_ABI_Band13_Clean_Infrared";

/** DWD's WMTS has no layer with a time, so its world map gets one here, to read GeoServer's tile matrix sets with. */
function dwdWithTime(): string {
    return fixture("dwd-wmts")
        .replace(
            "<Style isDefault",
            "<Dimension><ows:Identifier>time</ows:Identifier><Value>2026-11-19T12:00:00Z</Value></Dimension><Style isDefault",
        )
        .replaceAll("?format=image/png", "?format=image/png&amp;time={time}");
}

describe("readWmtsCapabilities", () => {
    it("reads NASA's GOES infrared: its ranges, its default style's legend, the provider and level 6 as the deepest", () => {
        const layer = readWmtsCapabilities(fixture("gibs-goes-ir"), GOES);
        expect(layer.extent.ranges).toHaveLength(3);
        expect(layer.extent.ranges.every((range) => range.step === 600)).toBe(true);
        expect(layer.extent.ranges[2].end).toBe(Date.UTC(2026, 10, 19, 20, 20) / 1000);
        expect(layer.styles).toEqual([
            { name: "default", legend: "https://gibs.earthdata.nasa.gov/legends/Clean_Longwave_Infrared_Window_Band_H.svg" },
        ]);
        expect(layer.attribution).toBe("National Aeronautics and Space Administration");
        expect(layer.maxZoom).toBe(6);
    });

    it("takes the template with the time in it, not NASA's others that give the newest picture whatever is asked", () => {
        const layer = readWmtsCapabilities(fixture("gibs-goes-ir"), GOES);
        expect(layer.url("default", Date.UTC(2026, 10, 19, 20, 20) / 1000)).toBe(
            `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${GOES}/default/2026-11-19T20:20:00Z/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`,
        );
    });

    it("addresses GeoServer's levels by their prefix, fills its lowercase {style}, and passes over its 512 pixel set", () => {
        const layer = readWmtsCapabilities(dwdWithTime(), "dwd:WORLDMAP");
        expect(layer.styles[0].name).toBe("worldmap");
        expect(layer.url("worldmap", Date.UTC(2026, 10, 19, 12) / 1000)).toBe(
            "https://maps.dwd.de/geoserver/gwc/service/wmts/rest/dwd:WORLDMAP/worldmap/EPSG:900913/EPSG:900913:{z}/{y}/{x}?format=image/png&time=2026-11-19T12:00:00Z",
        );
    });

    it("says so when the layer has no time, as DWD's don't", () => {
        expect(() => readWmtsCapabilities(fixture("dwd-wmts"), "dwd:WORLDMAP")).toThrow("the layer dwd:WORLDMAP has no time dimension");
    });

    it("says so when no template has the time in it", () => {
        const xml = fixture("gibs-goes-ir").replace(/\{Time\}\//g, "");
        expect(() => readWmtsCapabilities(xml, GOES)).toThrow("has no tile address with the time in it");
    });

    it("says so when the layer's only tile matrix set isn't Web Mercator's", () => {
        const xml = fixture("gibs-goes-ir").replace("<ScaleDenominator>559082264.0287178", "<ScaleDenominator>279541132.0143589");
        expect(() => readWmtsCapabilities(xml, GOES)).toThrow("has no tile matrix set in Web Mercator");
    });

    it("fills another dimension with its default, and refuses a placeholder that has none", () => {
        const withDimension = (extra: string) =>
            fixture("gibs-goes-ir")
                .replace(
                    "<Dimension>",
                    `<Dimension><ows:Identifier>elevation</ows:Identifier>${extra}<Value>0</Value></Dimension><Dimension>`,
                )
                .replace("/default/{Time}/", "/default/{Time}/{elevation}/");
        const layer = readWmtsCapabilities(withDimension("<Default>500</Default>"), GOES);
        expect(layer.url("default", 0)).toContain("/1970-01-01T00:00:00Z/500/GoogleMapsCompatible_Level6/");
        expect(() => readWmtsCapabilities(withDimension(""), GOES)).toThrow("has {elevation}, which has no value");
    });

    it("passes on the server's own error, and refuses what isn't a WMTS document", () => {
        const report = `<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1"><ows:Exception><ows:ExceptionText>Service is disabled</ows:ExceptionText></ows:Exception></ows:ExceptionReport>`;
        expect(() => readWmtsCapabilities(report, GOES)).toThrow("the server says: Service is disabled");
        expect(() => readWmtsCapabilities("<html></html>", GOES)).toThrow("the answer isn't a WMTS capabilities document");
        expect(() => readWmtsCapabilities(fixture("gibs-goes-ir"), "rain")).toThrow("the server has no layer rain");
    });
});
