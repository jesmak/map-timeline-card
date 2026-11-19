import { afterEach, describe, expect, it, vi } from "vitest";

import { MapTimelineCardEditor, rowText, sourceData, sourceFromForm } from "../src/editor";

describe("sourceData", () => {
    it("fills in the defaults, and shows a legend left out as the server's own, switched on", () => {
        const data = sourceData({ type: "wms", url: "https://example.com/wms", layer: "rain" });
        expect(data).toMatchObject({ history_minutes: 120, opacity: 1, show_legend: true, legend: "" });
    });

    it("shows a legend of false as switched off, and an address as the image of one's own", () => {
        expect(sourceData({ type: "wms", legend: false })).toMatchObject({ show_legend: false, legend: "" });
        expect(sourceData({ type: "wms", legend: "https://example.com/l.png" })).toMatchObject({
            show_legend: true,
            legend: "https://example.com/l.png",
        });
    });
});

describe("sourceFromForm", () => {
    const wms = { type: "wms" as const, name: "Rain", url: "https://example.com/wms", layer: "rain", style: "summer" };

    it("leaves out the defaults and the empty fields the form shows", () => {
        expect(sourceFromForm({ ...sourceData(wms), attribution: "" }, wms)).toEqual(wms);
    });

    it("writes the legend switched off as false, and an image of one's own as its address", () => {
        expect(sourceFromForm({ ...sourceData(wms), show_legend: false }, wms).legend).toBe(false);
        expect(sourceFromForm({ ...sourceData(wms), legend: "https://example.com/l.png" }, wms).legend).toBe("https://example.com/l.png");
    });

    it("keeps only the new type's fields when the type changes", () => {
        expect(sourceFromForm({ ...sourceData(wms), type: "xyz" }, wms)).toEqual({
            type: "xyz",
            name: "Rain",
            url: "https://example.com/wms",
        });
    });

    it("keeps a layer from WMS to WMTS, but not to a RainViewer API, whose layer is radar or satellite", () => {
        expect(sourceFromForm({ ...sourceData(wms), type: "wmts" }, wms).layer).toBe("rain");
        expect(sourceFromForm({ ...sourceData(wms), type: "rainviewer" }, wms).layer).toBeUndefined();
        const radar = { type: "rainviewer" as const, url: "https://api.example.com", layer: "radar" };
        expect(sourceFromForm({ ...sourceData(radar), type: "wms" }, radar).layer).toBeUndefined();
    });

    it("drops a legend from a type that has none, such as geo_location", () => {
        const strikes = { type: "geo_location" as const, source: "blitzortung" };
        expect(sourceFromForm({ ...sourceData(strikes), legend: "https://example.com/l.png" }, strikes)).toEqual(strikes);
    });
});

describe("RainViewer's default layer", () => {
    const radar = { type: "rainviewer" as const, url: "https://api.example.com" };

    it("shows radar chosen when the source has no layer, and doesn't write it", () => {
        expect(sourceData(radar).layer).toBe("radar");
        expect(sourceFromForm(sourceData(radar), radar)).toEqual(radar);
    });

    it("writes satellite, which isn't the default", () => {
        expect(sourceFromForm({ ...sourceData(radar), layer: "satellite" }, radar).layer).toBe("satellite");
    });
});

describe("rowText", () => {
    it("names a row by its own name, with the type and the layer below it", () => {
        expect(rowText({ name: "Rain" }, "rain_layer", "WMS")).toEqual({ name: "Rain", secondary: "WMS · rain_layer" });
    });

    it("names a row without a name by its layer, with only the type below it", () => {
        expect(rowText({}, "rain_layer", "WMS")).toEqual({ name: "rain_layer", secondary: "WMS" });
    });

    it("leaves the line below out when the title is the type itself", () => {
        expect(rowText({}, "", "geo_location entities")).toEqual({ name: "geo_location entities", secondary: "" });
    });
});

describe("reading a server's layers", () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        document.body.replaceChildren();
    });

    /** An editor showing its one WMS source, its address changed as a user types it. */
    async function typing(addresses: string[]) {
        vi.useFakeTimers();
        const fetch = vi.fn(() => Promise.resolve(new Response("<html></html>")));
        vi.stubGlobal("fetch", fetch);
        const editor = new MapTimelineCardEditor();
        editor.hass = {} as MapTimelineCardEditor["hass"];
        document.body.append(editor);
        const show = async (url: string) => {
            editor.setConfig({ type: "custom:map-timeline-card", sources: [{ type: "wms", url }] });
            (editor as unknown as { editing: number }).editing = 0;
            await editor.updateComplete;
        };
        for (const url of addresses) {
            await show(url);
            await vi.advanceTimersByTimeAsync(300);
        }
        return { editor, fetch };
    }

    it("reads once the address has stayed as it is, not at each key typed", async () => {
        const { fetch } = await typing(["https://example.com/w", "https://example.com/wm", "https://example.com/wms"]);
        expect(fetch).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(800);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(String((fetch.mock.calls[0] as unknown[])[0])).toMatch(/^https:\/\/example\.com\/wms\?.*request=GetCapabilities/i);
    });

    it("doesn't read once the editor is gone", async () => {
        const { editor, fetch } = await typing(["https://example.com/wms"]);
        editor.remove();
        await vi.advanceTimersByTimeAsync(800);
        expect(fetch).not.toHaveBeenCalled();
    });
});
