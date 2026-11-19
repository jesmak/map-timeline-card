/**
 * Reading a source: an image source's frames from now back as far as its config says and ahead as far as it has them,
 * its step and what it is drawn with, or a GeoJSON source's features.
 */
import { readGeoJson, type GeoJsonData } from "./geojson";
import type { SourceOptions } from "./options";
import { catalogueUrl, readCatalogue, type RainViewerLayer } from "./rainviewer";
import { framesBetween, stepOf } from "./time";
import { capabilitiesUrl, readCapabilities, tileUrl } from "./wms";
import { readWmtsCapabilities } from "./wmts";
import { xyzFrames, xyzUrl } from "./xyz";

export interface LoadedImages {
    kind: "images";
    /** Oldest first, in seconds. */
    frames: number[];
    /** In seconds. */
    step: number;
    /** A frame's tiles, as MapLibre asks for them. */
    url: (time: number) => string;
    legend: string | null;
    attribution: string;
    /** The deepest zoom the server has tiles for, or null when it doesn't say. */
    maxZoom: number | null;
}

export interface LoadedFeatures {
    kind: "features";
    data: GeoJsonData;
    /** How often it is read again, in seconds. */
    step: number;
    legend: string | null;
    attribution: string;
}

export type LoadedSource = LoadedImages | LoadedFeatures;

export async function loadSource(options: SourceOptions, now: number): Promise<LoadedSource> {
    switch (options.type) {
        case "wmts":
            return loadWmts(options, now);
        case "xyz":
            return loadXyz(options, now);
        case "rainviewer":
            return loadRainViewer(options, now);
        case "geojson":
            return loadGeoJson(options);
        default:
            return loadWms(options, now);
    }
}

async function loadWms(options: SourceOptions, now: number): Promise<LoadedImages> {
    const layer = readCapabilities(await fetchText(capabilitiesUrl(options.url)), options.layer);
    const style = pickStyle(options, layer.styles);
    const defaultStep = options.stepMinutes * 60;
    const frames = framesBetween(layer.extent, now - options.historyMinutes * 60, Infinity, defaultStep);
    return {
        kind: "images",
        frames,
        step: stepOf(layer.extent, frames, defaultStep),
        url: (time) => tileUrl(options.url, options.layer, style?.name ?? "", time),
        legend: options.legend === false ? null : (options.legend ?? style?.legend ?? null),
        attribution: options.attribution || layer.attribution,
        maxZoom: null,
    };
}

/** A WMTS source's `url` is its capabilities document's, as the server gives it. */
async function loadWmts(options: SourceOptions, now: number): Promise<LoadedImages> {
    const layer = readWmtsCapabilities(await fetchText(options.url), options.layer);
    const style = pickStyle(options, layer.styles);
    const defaultStep = options.stepMinutes * 60;
    const frames = framesBetween(layer.extent, now - options.historyMinutes * 60, Infinity, defaultStep);
    return {
        kind: "images",
        frames,
        step: stepOf(layer.extent, frames, defaultStep),
        url: (time) => layer.url(style?.name ?? "", time),
        legend: options.legend === false ? null : (options.legend ?? style?.legend ?? null),
        attribution: options.attribution || layer.attribution,
        maxZoom: layer.maxZoom,
    };
}

/** An XYZ source has nothing to read: its frames come from the clock. */
function loadXyz(options: SourceOptions, now: number): Promise<LoadedImages> {
    const step = options.stepMinutes * 60;
    return Promise.resolve({
        kind: "images",
        frames: xyzFrames(now, step, options.delayMinutes * 60, options.historyMinutes * 60),
        step,
        url: (time) => xyzUrl(options.url, time),
        legend: typeof options.legend === "string" ? options.legend : null,
        attribution: options.attribution,
        maxZoom: null,
    });
}

async function loadRainViewer(options: SourceOptions, now: number): Promise<LoadedImages> {
    const catalogue = readCatalogue(
        parseJson(await fetchText(catalogueUrl(options.url)), "the answer isn't a RainViewer API catalogue"),
        options.layer as RainViewerLayer,
        options.colorScheme,
    );
    const frames = catalogue.frames.filter((time) => time >= now - options.historyMinutes * 60);
    return {
        kind: "images",
        frames,
        step: stepOf({ times: frames, ranges: [] }, frames, options.stepMinutes * 60),
        url: catalogue.url,
        // The API has neither legends nor credits of its own.
        legend: typeof options.legend === "string" ? options.legend : null,
        attribution: options.attribution,
        maxZoom: null,
    };
}

async function loadGeoJson(options: SourceOptions): Promise<LoadedFeatures> {
    return {
        kind: "features",
        // Revalidated every time: Home Assistant serves a file of /config/www with a month's max-age, so a file a user's
        // script rewrites would otherwise stay as the browser first saw it. Its service worker still answers from its own
        // cache while it fetches the new file, so such a file shows one read late.
        data: readGeoJson(parseJson(await fetchText(options.url, "no-cache"), "the answer isn't GeoJSON"), options.timeProperty),
        step: options.stepMinutes * 60,
        legend: typeof options.legend === "string" ? options.legend : null,
        attribution: options.attribution,
    };
}

function pickStyle<T extends { name: string }>(options: SourceOptions, styles: T[]): T | undefined {
    if (!options.style) return styles[0];
    const style = styles.find((candidate) => candidate.name === options.style);
    if (!style) throw new Error(`the layer has no style ${options.style}, only ${styles.map((candidate) => candidate.name).join(", ")}`);
    return style;
}

function parseJson(text: string, error: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(error);
    }
}

async function fetchText(url: string, cache: RequestCache = "default"): Promise<string> {
    const response = await fetch(url, { cache });
    if (!response.ok) throw new Error(`the server answered ${response.status}`);
    return response.text();
}
