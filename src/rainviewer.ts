/**
 * A server with RainViewer's v2 API, such as LibreWXR: a catalogue (`/public/weather-maps.json`) listing the radar's
 * past and forecast frames and the satellite's, each with a path its tiles are under.
 */

export type RainViewerLayer = "radar" | "satellite";

export interface Catalogue {
    /** Oldest first, in seconds. */
    frames: number[];
    /** A frame's tiles, as MapLibre asks for them. */
    url: (time: number) => string;
    /** The colour scheme the radar's tiles are drawn in, or null for the satellite's, which have none. */
    scheme: number | null;
}

interface Frame {
    time: number;
    path: string;
}

/** The catalogue's address, from the server's as a user gives it, with or without a slash at its end. */
export function catalogueUrl(server: string): string {
    return `${server.replace(/\/+$/, "")}/public/weather-maps.json`;
}

/**
 * The frames of a layer in a catalogue, and their tiles in the colour scheme asked for, or the first the catalogue lists
 * when none is. Throws when the catalogue can't be read or doesn't offer the scheme.
 */
export function readCatalogue(json: unknown, layer: RainViewerLayer, scheme: number | null): Catalogue {
    const catalogue = record(json);
    const host = typeof catalogue?.host === "string" ? catalogue.host.replace(/\/+$/, "") : "";
    if (!catalogue || !/^https?:\/\//.test(host)) throw new Error("the answer isn't a RainViewer API catalogue");
    const section = record(catalogue[layer]);
    const lists = layer === "radar" ? [section?.past, section?.nowcast] : [section?.infrared];
    const frames: Frame[] = lists.flatMap((list) => (Array.isArray(list) ? list.flatMap(frameOf) : []));
    const paths = new Map(frames.map((frame) => [frame.time, frame.path]));
    const times = [...paths.keys()].sort((a, b) => a - b);

    if (layer === "satellite") {
        // A satellite frame has one look, asked for as scheme 0 without smoothing, as RainViewer's own API documents it.
        return { frames: times, url: (time) => `${host}${paths.get(time)}/256/{z}/{x}/{y}/0/0_0.png`, scheme: null };
    }
    const offered = (Array.isArray(section?.colorSchemes) ? section.colorSchemes : [])
        .map((entry) => record(entry)?.id)
        .filter((id): id is number => typeof id === "number");
    // RainViewer's own catalogue lists no schemes and draws every number from 0 to 4 alike, so 0 does for one without a list.
    const chosen = scheme ?? offered[0] ?? 0;
    if (offered.length && !offered.includes(chosen)) {
        throw new Error(`the server has no colour scheme ${chosen}, only ${offered.join(", ")}`);
    }
    // 1_1: smoothed, and snow in colours of its own, RainViewer's defaults.
    return { frames: times, url: (time) => `${host}${paths.get(time)}/256/{z}/{x}/{y}/${chosen}/1_1.png`, scheme: chosen };
}

function frameOf(entry: unknown): Frame[] {
    const frame = record(entry);
    return typeof frame?.time === "number" && typeof frame.path === "string" && frame.path.startsWith("/")
        ? [{ time: frame.time, path: frame.path }]
        : [];
}

function record(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
