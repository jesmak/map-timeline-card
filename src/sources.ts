/**
 * Reading a source: its frames from now back as far as its config says and ahead as far as it has them, its step,
 * and what it is drawn with.
 */
import type { SourceOptions } from "./options";
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

/** A WMS layer, the only format so far. */
export async function loadSource(options: SourceOptions, now: number): Promise<LoadedSource> {
    const response = await fetch(capabilitiesUrl(options.url));
    if (!response.ok) throw new Error(`the server answered ${response.status}`);
    const layer = readCapabilities(await response.text(), options.layer);
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
