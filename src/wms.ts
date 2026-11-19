/**
 * A WMS layer with a time dimension (WMS 1.3.0): its times, styles and legends from the capabilities, and its frames
 * as map tiles in Web Mercator.
 */
import { parseTimeDimension, type TimeExtent } from "./time";

export interface WmsStyle {
    name: string;
    /** The legend image the server offers for the style, or null. */
    legend: string | null;
}

export interface WmsLayer {
    extent: TimeExtent;
    /** The layer's styles, its parents' included, in the order the capabilities list them. */
    styles: WmsStyle[];
    /** The attribution the capabilities give, or "". */
    attribution: string;
}

const XLINK = "http://www.w3.org/1999/xlink";

/** The element's children with this name, whatever namespace the server writes them in. */
function children(element: Element, name: string): Element[] {
    return [...element.children].filter((child) => child.localName === name);
}

function child(element: Element, name: string): Element | undefined {
    return children(element, name)[0];
}

/** The `Layer` elements from this one up to the root, nearest first: a layer inherits its dimensions and styles from them. */
function ancestry(layer: Element): Element[] {
    const chain: Element[] = [];
    for (let element: Element | null = layer; element; element = element.parentElement) {
        if (element.localName === "Layer") chain.push(element);
    }
    return chain;
}

/**
 * The layer named `name` in a WMS 1.3.0 capabilities document. Throws with what is wrong when the document can't be
 * read, the layer isn't in it, or the layer has no time dimension, as the card has nothing to play then.
 */
export function readCapabilities(xml: string, name: string): WmsLayer {
    const document = new DOMParser().parseFromString(xml, "text/xml");
    const root = document.documentElement;
    if (!root || root.localName !== "WMS_Capabilities") {
        const error = document.getElementsByTagName("ServiceException")[0]?.textContent?.trim();
        throw new Error(error ? `the server says: ${error}` : "the answer isn't a WMS 1.3.0 capabilities document");
    }
    const layer = [...root.querySelectorAll("*")].find(
        (element) => element.localName === "Layer" && child(element, "Name")?.textContent?.trim() === name,
    );
    if (!layer) throw new Error(`the server has no layer ${name}`);
    const chain = ancestry(layer);

    // The nearest time dimension wins, as WMS lets a layer override its parent's.
    const dimension = chain
        .flatMap((element) => children(element, "Dimension"))
        .find((element) => element.getAttribute("name")?.toLowerCase() === "time");
    if (!dimension?.textContent?.trim()) throw new Error(`the layer ${name} has no time dimension`);

    // A layer's own styles come first, then those it inherits.
    const styles: WmsStyle[] = chain
        .flatMap((element) => children(element, "Style"))
        .map((style) => ({
            name: child(style, "Name")?.textContent?.trim() ?? "",
            legend: legendOf(style),
        }))
        .filter((style, i, all) => style.name && all.findIndex((other) => other.name === style.name) === i);

    const attribution = chain.map((element) => child(element, "Attribution")).find(Boolean);
    return {
        extent: parseTimeDimension(dimension.textContent),
        styles,
        attribution: attribution ? (child(attribution, "Title")?.textContent?.trim() ?? "") : "",
    };
}

function legendOf(style: Element): string | null {
    const resource = child(child(style, "LegendURL") ?? style, "OnlineResource");
    return resource?.getAttributeNS(XLINK, "href") || resource?.getAttribute("xlink:href") || null;
}

/** The URL of the capabilities, from the service's URL as a user gives it, with or without a query of its own. */
export function capabilitiesUrl(base: string): string {
    return withQuery(base, { service: "WMS", version: "1.3.0", request: "GetCapabilities" });
}

/**
 * A tile of one frame, as MapLibre asks for it: `{bbox-epsg-3857}` is filled in by MapLibre for each tile. The style
 * is the server's own when `style` is "".
 */
export function tileUrl(base: string, layer: string, style: string, time: number): string {
    const url = withQuery(base, {
        service: "WMS",
        version: "1.3.0",
        request: "GetMap",
        layers: layer,
        styles: style,
        format: "image/png",
        transparent: "true",
        crs: "EPSG:3857",
        width: "256",
        height: "256",
        time: new Date(time * 1000).toISOString().replace(".000Z", "Z"),
    });
    // MapLibre replaces the placeholder only when its braces are left as they are.
    return `${url}&bbox={bbox-epsg-3857}`;
}

/** Adds the parameters to a URL that may have a query of its own, replacing any of the same name, whatever its case. */
function withQuery(base: string, params: Record<string, string>): string {
    const url = new URL(base);
    for (const key of [...url.searchParams.keys()]) {
        if (Object.keys(params).some((name) => name.toLowerCase() === key.toLowerCase())) url.searchParams.delete(key);
    }
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
}
