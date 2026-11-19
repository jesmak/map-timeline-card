import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { capabilitiesUrl, listWmsLayers, readCapabilities, tileUrl } from "../src/wms";

// Read from the repo's root, where the tests run: under happy-dom import.meta.url isn't a file URL. The XML declaration
// goes, as happy-dom refuses GeoMet's `version='1.0'` in single quotes, which XML allows and browsers read.
const fixture = (name: string) => readFileSync(`tests/fixtures/${name}.xml`, "utf8").replace(/^<\?xml[^>]*\?>/, "");

describe("readCapabilities", () => {
    it("reads FMI's radar: its time range, its two styles and their legends", () => {
        const layer = readCapabilities(fixture("fmi-radar"), "suomi_dbz_eureffin");
        expect(layer.extent.ranges).toHaveLength(1);
        expect(layer.extent.ranges[0].step).toBe(300);
        expect(layer.styles.map((style) => style.name)).toEqual(["Radar dbz Summer", "raster"]);
        expect(layer.styles[0].legend).toMatch(/^https:\/\/openwms\.fmi\.fi\/.*request=GetLegendGraphic.*layer=suomi_dbz_eureffin$/);
        expect(layer.attribution).toBe("");
    });

    it("reads EUMETSAT's infrared at its ten minute period", () => {
        const layer = readCapabilities(fixture("eumetsat-ir"), "ir105_hrfi");
        expect(layer.extent.ranges[0].step).toBe(600);
        expect(layer.styles[0].name).toBe("mtg_fd_ir105_hrfi_grayscale");
    });

    it("reads GeoMet's radar, its attribution inherited from the root layer", () => {
        const layer = readCapabilities(fixture("geomet-radar"), "RADAR_1KM_RRAI");
        expect(layer.extent.ranges[0].step).toBe(360);
        expect(layer.attribution).toMatch(/Meteorological Service of Canada/);
        expect(layer.styles[0].name).toBe("Radar-Rain_14colors");
    });

    it("inherits a time dimension and styles from a parent layer, the layer's own styles first", () => {
        const xml = `<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms" xmlns:xlink="http://www.w3.org/1999/xlink">
            <Capability><Layer><Dimension name="time" units="ISO8601">2026-11-19T12:00:00Z,2026-11-19T12:10:00Z</Dimension>
                <Style><Name>parent</Name></Style>
                <Layer><Name>rain</Name><Style><Name>own</Name><LegendURL><OnlineResource xlink:href="https://example.com/legend.png"/></LegendURL></Style></Layer>
            </Layer></Capability></WMS_Capabilities>`;
        const layer = readCapabilities(xml, "rain");
        expect(layer.extent.times).toHaveLength(2);
        expect(layer.styles).toEqual([
            { name: "own", legend: "https://example.com/legend.png" },
            { name: "parent", legend: null },
        ]);
    });

    it("takes a layer's own time dimension over its parent's", () => {
        const xml = `<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms">
            <Capability><Layer><Dimension name="time" units="ISO8601">2026-11-19T12:00:00Z</Dimension>
                <Layer><Name>rain</Name><Dimension name="time" units="ISO8601">2026-11-19T12:00:00Z/2026-11-19T13:00:00Z/PT5M</Dimension></Layer>
            </Layer></Capability></WMS_Capabilities>`;
        const layer = readCapabilities(xml, "rain");
        expect(layer.extent.times).toEqual([]);
        expect(layer.extent.ranges[0].step).toBe(300);
    });

    it("says which layer is missing", () => {
        expect(() => readCapabilities(fixture("fmi-radar"), "Radar:suomi_dbz_eureffin")).toThrow("no layer Radar:suomi_dbz_eureffin");
    });

    it("says when a layer has no time dimension", () => {
        const xml = `<WMS_Capabilities version="1.3.0"><Capability><Layer><Name>still</Name></Layer></Capability></WMS_Capabilities>`;
        expect(() => readCapabilities(xml, "still")).toThrow("no time dimension");
    });

    it("passes on the server's own exception", () => {
        const xml = `<ServiceExceptionReport version="1.3.0"><ServiceException>Unknown service</ServiceException></ServiceExceptionReport>`;
        expect(() => readCapabilities(xml, "rain")).toThrow("the server says: Unknown service");
    });

    it("refuses what isn't capabilities at all", () => {
        expect(() => readCapabilities("<html><body>Not found</body></html>", "rain")).toThrow("isn't a WMS 1.3.0 capabilities");
    });
});

describe("capabilitiesUrl", () => {
    it("adds the request to a bare URL", () => {
        expect(capabilitiesUrl("https://example.com/wms")).toBe(
            "https://example.com/wms?service=WMS&version=1.3.0&request=GetCapabilities",
        );
    });

    it("keeps a query of the user's own and replaces a request given in another case", () => {
        const url = new URL(capabilitiesUrl("https://example.com/wms?map=radar&REQUEST=GetMap"));
        expect(url.searchParams.get("map")).toBe("radar");
        expect(url.searchParams.get("request")).toBe("GetCapabilities");
        expect(url.searchParams.has("REQUEST")).toBe(false);
    });
});

describe("tileUrl", () => {
    it("asks for the frame's time in Web Mercator, leaving the bounding box for MapLibre to fill in", () => {
        const url = tileUrl("https://example.com/wms", "rain", "", Date.UTC(2026, 10, 19, 17, 5) / 1000);
        expect(url.endsWith("&bbox={bbox-epsg-3857}")).toBe(true);
        const params = new URL(url.replace("{bbox-epsg-3857}", "0")).searchParams;
        expect(params.get("time")).toBe("2026-11-19T17:05:00Z");
        expect(params.get("crs")).toBe("EPSG:3857");
        expect(params.get("layers")).toBe("rain");
        expect(params.get("styles")).toBe("");
        expect(params.get("transparent")).toBe("true");
    });
});

describe("listWmsLayers", () => {
    it("lists the layers with a time dimension, their own or a parent's, and none without", () => {
        const xml = `<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms"><Capability><Layer>
            <Layer><Name>still</Name></Layer>
            <Layer><Dimension name="time">2026-11-19T12:00:00Z</Dimension><Name>rain</Name><Layer><Name>rain_child</Name></Layer></Layer>
        </Layer></Capability></WMS_Capabilities>`;
        expect(listWmsLayers(xml)).toEqual(["rain", "rain_child"]);
    });

    it("finds FMI's radar among its layers, and nothing in what isn't a capabilities document", () => {
        expect(listWmsLayers(fixture("fmi-radar"))).toContain("suomi_dbz_eureffin");
        expect(listWmsLayers("<html></html>")).toEqual([]);
    });
});
