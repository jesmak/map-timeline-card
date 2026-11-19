/**
 * Reading a source: its frames from now back as far as its config says and ahead as far as it has them, its step,
 * and what it is drawn with.
 */
import type { SourceOptions } from "./options";
import { catalogueUrl, readCatalogue, type RainViewerLayer } from "./rainviewer";
import { framesBetween, stepOf } from "./time";
import { capabilitiesUrl, readCapabilities, tileUrl } from "./wms";

export interface LoadedSource {
    /** Oldest first, in seconds. */
    frames: number[];
    /** In seconds. */
    step: number;
    /** A frame's tiles, as MapLibre asks for them. */
    url: (time: number) => string;
    legend: string | null;
    attribution: string;
}

export async function loadSource(options: SourceOptions, now: number): Promise<LoadedSource> {
    return options.type === "rainviewer" ? loadRainViewer(options, now) : loadWms(options, now);
}

async function loadWms(options: SourceOptions, now: number): Promise<LoadedSource> {
    const layer = readCapabilities(await fetchText(capabilitiesUrl(options.url)), options.layer);
    const style = options.style ? layer.styles.find((candidate) => candidate.name === options.style) : layer.styles[0];
    if (options.style && !style) {
        throw new Error(`the layer has no style ${options.style}, only ${layer.styles.map((candidate) => candidate.name).join(", ")}`);
    }
    const defaultStep = options.stepMinutes * 60;
    const frames = framesBetween(layer.extent, now - options.historyMinutes * 60, Infinity, defaultStep);
    return {
        frames,
        step: stepOf(layer.extent, frames, defaultStep),
        url: (time) => tileUrl(options.url, options.layer, style?.name ?? "", time),
        legend: options.legend === false ? null : (options.legend ?? style?.legend ?? null),
        attribution: options.attribution || layer.attribution,
    };
}

async function loadRainViewer(options: SourceOptions, now: number): Promise<LoadedSource> {
    const text = await fetchText(catalogueUrl(options.url));
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        throw new Error("the answer isn't a RainViewer API catalogue");
    }
    const catalogue = readCatalogue(json, options.layer as RainViewerLayer, options.colorScheme);
    const frames = catalogue.frames.filter((time) => time >= now - options.historyMinutes * 60);
    return {
        frames,
        step: stepOf({ times: frames, ranges: [] }, frames, options.stepMinutes * 60),
        url: catalogue.url,
        // The API has neither legends nor credits of its own.
        legend: typeof options.legend === "string" ? options.legend : null,
        attribution: options.attribution,
    };
}

async function fetchText(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`the server answered ${response.status}`);
    return response.text();
}
