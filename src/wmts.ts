/**
 * A WMTS layer with a time dimension (WMTS 1.0.0): its times, styles and legends from the capabilities, and its frames
 * as tiles from its REST template, in a tile matrix set that is Web Mercator's own levels.
 */
import { isoTime, parseTimeDimension, type TimeExtent } from "./time";
import { child, children, XLINK, type WmsStyle } from "./wms";

export interface WmtsLayer {
    extent: TimeExtent;
    /** The layer's styles, its default first. */
    styles: WmsStyle[];
    /** The service's provider, or "". */
    attribution: string;
    /** The deepest zoom the tile matrix set has. */
    maxZoom: number;
    /** A frame's tiles in a style, as MapLibre asks for them. */
    url: (style: string, time: number) => string;
}

/** The scale denominator of a 256 pixel tile at zoom 0 in Web Mercator, as WMTS's GoogleMapsCompatible set gives it. */
const ZOOM0_SCALE = 559082264.0287178;

/** A tile matrix set's levels as MapLibre's zooms: each level's identifier is `prefix` and its zoom. */
interface Levels {
    id: string;
    prefix: string;
    maxZoom: number;
}

function text(element: Element | undefined): string {
    return element?.textContent?.trim() ?? "";
}

/**
 * The layer `name` in a WMTS capabilities document. Throws with what is wrong when the document can't be read, or the
 * layer isn't in it or can't be drawn: no time dimension, no tile template, or no tile matrix set in Web Mercator.
 */
export function readWmtsCapabilities(xml: string, name: string): WmtsLayer {
    const document = new DOMParser().parseFromString(xml, "text/xml");
    const root = document.documentElement;
    const contents = root?.localName === "Capabilities" ? child(root, "Contents") : undefined;
    if (!contents) {
        const error = [...document.getElementsByTagName("*")].find((element) => element.localName === "ExceptionText");
        throw new Error(error ? `the server says: ${text(error)}` : "the answer isn't a WMTS capabilities document");
    }
    // Only the layers and tile matrix sets under Contents are walked: NASA's capabilities run to megabytes.
    const layer = children(contents, "Layer").find((candidate) => text(child(candidate, "Identifier")) === name);
    if (!layer) throw new Error(`the server has no layer ${name}`);

    const dimensions = children(layer, "Dimension");
    const time = dimensions.find((dimension) => text(child(dimension, "Identifier")).toLowerCase() === "time");
    const values = time ? children(time, "Value").map(text).filter(Boolean) : [];
    if (!time || !values.length) throw new Error(`the layer ${name} has no time dimension`);

    const styles: WmsStyle[] = children(layer, "Style")
        .sort((a, b) => Number(b.getAttribute("isDefault") === "true") - Number(a.getAttribute("isDefault") === "true"))
        .map((style) => {
            const legend = child(style, "LegendURL");
            return {
                name: text(child(style, "Identifier")),
                legend: legend?.getAttributeNS(XLINK, "href") || legend?.getAttribute("xlink:href") || null,
            };
        })
        .filter((style) => style.name);

    // A template without the time gives the newest picture whatever time is asked for, as NASA's second and third do.
    const timeId = text(child(time, "Identifier")).toLowerCase();
    const templates = children(layer, "ResourceURL")
        .filter((resource) => resource.getAttribute("resourceType") === "tile")
        .filter((resource) => (resource.getAttribute("template") ?? "").toLowerCase().includes(`{${timeId}}`));
    const template = (templates.find((resource) => resource.getAttribute("format") === "image/png") ?? templates[0])?.getAttribute(
        "template",
    );
    if (!template) throw new Error(`the layer ${name} has no tile address with the time in it`);

    const linked = new Set(children(layer, "TileMatrixSetLink").map((link) => text(child(link, "TileMatrixSet"))));
    const levels = children(contents, "TileMatrixSet")
        .filter((set) => linked.has(text(child(set, "Identifier"))))
        .map(webMercatorLevels)
        .filter((set): set is Levels => set !== null)
        .sort((a, b) => b.maxZoom - a.maxZoom)[0];
    if (!levels) throw new Error(`the layer ${name} has no tile matrix set in Web Mercator`);

    // Placeholders are matched whatever their case: the standard writes {Style}, GeoServer {style}.
    const fixed = new Map<string, string>([
        ["tilematrixset", levels.id],
        ["tilematrix", `${levels.prefix}{z}`],
        ["tilerow", "{y}"],
        ["tilecol", "{x}"],
    ]);
    for (const dimension of dimensions) {
        if (dimension === time) continue;
        const id = text(child(dimension, "Identifier")).toLowerCase();
        const fallback = text(child(dimension, "Default"));
        if (id && fallback) fixed.set(id, fallback);
    }
    for (const [, placeholder] of template.matchAll(/\{(\w+)\}/g)) {
        const id = placeholder.toLowerCase();
        if (!fixed.has(id) && id !== "style" && id !== timeId)
            throw new Error(`the layer's tile address has {${placeholder}}, which has no value`);
    }

    const provider = child(child(root, "ServiceProvider") ?? root, "ProviderName");
    return {
        extent: parseTimeDimension(values.join(",")),
        styles,
        attribution: text(provider),
        maxZoom: levels.maxZoom,
        url: (style, at) =>
            template.replace(/\{(\w+)\}/g, (_, placeholder: string) => {
                const id = placeholder.toLowerCase();
                return id === timeId ? isoTime(at) : id === "style" ? style : fixed.get(id)!;
            }),
    };
}

/**
 * A tile matrix set's levels, when they are Web Mercator's from zoom 0 down without a gap, in 256 pixel tiles, each
 * named by a common prefix and its zoom ("5" in NASA's sets, "EPSG:900913:5" in GeoServer's). Null for any other set,
 * which MapLibre's `{z}` can't address.
 */
function webMercatorLevels(set: Element): Levels | null {
    if (!/(?:^|:)(?:3857|900913)$/.test(text(child(set, "SupportedCRS")))) return null;
    const matrices = children(set, "TileMatrix").map((matrix) => ({
        id: text(child(matrix, "Identifier")),
        zoom: Math.log2(ZOOM0_SCALE / Number(text(child(matrix, "ScaleDenominator")))),
        width: Number(text(child(matrix, "TileWidth"))),
    }));
    if (!matrices.length) return null;
    const prefix = matrices[0].id.replace(/\d+$/, "");
    const ordered = [...matrices].sort((a, b) => a.zoom - b.zoom);
    const fits = ordered.every(
        (matrix, zoom) => matrix.width === 256 && Math.abs(matrix.zoom - zoom) < 0.01 && matrix.id === `${prefix}${zoom}`,
    );
    return fits ? { id: text(child(set, "Identifier")), prefix, maxZoom: ordered.length - 1 } : null;
}
