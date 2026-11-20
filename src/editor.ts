/**
 * The card's visual editor: the map's options and the list of sources, each source edited in a view of its own with only
 * the fields of its type, as Home Assistant's own editors edit a tile card's features.
 */
import { LitElement, css, html, nothing } from "lit";
import type { TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";

import type { HomeAssistant } from "./hass";
import { browserLanguage, translate } from "./localize/localize";
import {
    DEFAULT_HISTORY_MINUTES,
    DEFAULT_MAP_HEIGHT,
    DEFAULT_REGION_ZOOM,
    DEFAULT_SPEED,
    DEFAULT_STALE_STEPS,
    DEFAULT_STEP_MINUTES,
    DEFAULT_TIME_ATTRIBUTE,
    DEFAULT_VISIBLE_MINUTES,
    DEFAULT_ZOOM,
    MAP_STYLES,
    MAX_ZOOM,
    MIN_MAP_HEIGHT,
    RAINVIEWER_LAYERS,
    SOURCE_TYPES,
    type SourceType,
} from "./options";
import { rowStepData, rowStepSchema, tidyRowStep, type RowStepConfig } from "./rows";
import { capabilitiesUrl, listWmsLayers, readCapabilities } from "./wms";
import { listWmtsLayers, readWmtsCapabilities } from "./wmts";

type Source = Record<string, unknown> & { type?: SourceType };

/** Shown in the form but left out of the configuration. */
const CARD_DEFAULTS: Record<string, unknown> = {
    map_style: "default",
    zoom: DEFAULT_ZOOM,
    region_zoom: DEFAULT_REGION_ZOOM,
    map_height: DEFAULT_MAP_HEIGHT,
    speed: DEFAULT_SPEED,
};
const SOURCE_DEFAULTS: Record<string, unknown> = {
    history_minutes: DEFAULT_HISTORY_MINUTES,
    opacity: 1,
    step_minutes: DEFAULT_STEP_MINUTES,
    stale_steps: DEFAULT_STALE_STEPS,
    delay_minutes: 0,
    visible_minutes: DEFAULT_VISIBLE_MINUTES,
    timeline_marks: false,
    time_attribute: DEFAULT_TIME_ATTRIBUTE,
    show_legend: true,
};

/** Each type's fields: those that say what the source is, and the rarely needed ones behind Advanced. */
const SOURCE_FIELDS: Record<SourceType, { main: string[]; advanced: string[] }> = {
    wms: {
        main: ["url", "layer", "style"],
        advanced: ["history_minutes", "opacity", "max_zoom", "step_minutes", "stale_steps", "show_legend", "legend", "attribution"],
    },
    wmts: {
        main: ["url", "layer", "style"],
        advanced: ["history_minutes", "opacity", "max_zoom", "step_minutes", "stale_steps", "show_legend", "legend", "attribution"],
    },
    xyz: { main: ["url", "step_minutes", "delay_minutes"], advanced: ["history_minutes", "opacity", "max_zoom", "legend", "attribution"] },
    rainviewer: {
        main: ["url", "layer", "color_scheme"],
        advanced: ["history_minutes", "opacity", "max_zoom", "stale_steps", "legend", "attribution"],
    },
    geojson: {
        main: ["url", "time_property", "visible_minutes", "timeline_marks", "color"],
        advanced: ["history_minutes", "step_minutes", "legend", "attribution"],
    },
    geo_location: {
        main: ["source", "visible_minutes", "timeline_marks", "color"],
        advanced: ["history_minutes", "step_minutes", "time_attribute", "attribution"],
    },
};

const TYPE_ICONS: Record<SourceType, string> = {
    wms: "mdi:layers-outline",
    wmts: "mdi:layers-outline",
    xyz: "mdi:layers-outline",
    rainviewer: "mdi:layers-outline",
    geojson: "mdi:map-marker-multiple-outline",
    geo_location: "mdi:map-marker-multiple-outline",
};

/** How long an address must stay as it is before its server is read. */
const READ_DELAY_MS = 800;

const minutes = (min: number, max: number) => ({ number: { min, max, step: 1, mode: "box", unit_of_measurement: "min" } });
const TEXT = { text: {} };

/** What a server offers, read once per address: its layers, and each layer's styles as they are asked for. */
interface ServerOffer {
    status: "loading" | "ok" | "failed";
    layers: string[];
    xml: string;
    styles: Map<string, string[]>;
}

/**
 * A source as the form shows it: its defaults filled in, and its legend as a switch and an address of its own, as the
 * configuration's one `legend` can be false, an address or left out.
 */
export function sourceData(source: Source): Record<string, unknown> {
    return {
        ...SOURCE_DEFAULTS,
        // A RainViewer API's source without a layer draws the radar, and shows it chosen.
        ...(source.type === "rainviewer" ? { layer: "radar" } : {}),
        ...source,
        show_legend: source.legend !== false,
        legend: typeof source.legend === "string" ? source.legend : "",
    };
}

/**
 * A source from what the form gives, without its defaults and empty fields. Only its type's fields are kept, so a WMS
 * layer doesn't linger in an XYZ source's configuration. A RainViewer API's layer is `radar` or `satellite`, no WMS
 * layer's name, so a layer goes when the type changes to or from it, and its default `radar` isn't written.
 */
export function sourceFromForm(value: Record<string, unknown>, before: Source): Source {
    const type = (value.type as SourceType | undefined) ?? before.type ?? "wms";
    const fields = SOURCE_FIELDS[type];
    const kept = new Set(["name", "icon", ...fields.main, ...fields.advanced]);
    const dropLayer = type !== before.type && (type === "rainviewer" || before.type === "rainviewer");
    const legend = value.show_legend === false ? false : value.legend || undefined;
    const source: Source = { type };
    for (const [key, entry] of Object.entries(value)) {
        if (!kept.has(key) || key === "show_legend" || key === "legend") continue;
        if (entry === undefined || entry === null || entry === "" || SOURCE_DEFAULTS[key] === entry) continue;
        if (key === "layer" && (dropLayer || (type === "rainviewer" && entry === "radar"))) continue;
        source[key] = entry;
    }
    if (legend !== undefined && kept.has("legend")) source.legend = legend;
    return source;
}

/**
 * A source's row in the list: its own name, or else its layer or entities' source, or else its type. The line below
 * names the type and, under a name of its own, the layer too, and is left out when it would only repeat the title.
 */
export function rowText(source: Source, detail: string, typeName: string): { name: string; secondary: string } {
    const own = typeof source.name === "string" ? source.name : "";
    const name = own || detail || typeName;
    return { name, secondary: name === typeName ? "" : [typeName, own ? detail : ""].filter(Boolean).join(" · ") };
}

function withoutDefaults(config: Record<string, unknown>, defaults: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(config).filter(([key, value]) => value !== undefined && value !== null && value !== "" && defaults[key] !== value),
    );
}

export class MapTimelineCardEditor extends LitElement {
    @property({ attribute: false }) public hass?: HomeAssistant;
    @state() private config: Record<string, unknown> = { type: "custom:map-timeline-card", sources: [] };
    /** The source being edited in its own view, or null for the list. */
    @state() private editing: number | null = null;
    @state() private servers = new Map<string, ServerOffer>();
    private waiting?: { key: string; timer: ReturnType<typeof setTimeout> };

    public disconnectedCallback(): void {
        super.disconnectedCallback();
        // A read waiting for its address to settle isn't started once the editor is gone.
        clearTimeout(this.waiting?.timer);
        this.waiting = undefined;
    }

    public setConfig(config: Record<string, unknown>): void {
        this.config = { ...config };
        if (this.editing !== null && this.editing >= this.sources().length) this.editing = null;
    }

    protected render(): TemplateResult | typeof nothing {
        if (!this.hass) return nothing;
        return this.editing === null ? this.renderList() : this.renderSource(this.editing);
    }

    private renderList(): TemplateResult {
        const sources = this.sources();
        return html`
            <ha-form
                .hass=${this.hass}
                .data=${{ ...CARD_DEFAULTS, ...rowStepData(this.config as RowStepConfig), ...this.config }}
                .schema=${this.cardSchema()}
                .computeLabel=${(entry: { name: string }) => this.text(`editor.${entry.name}`)}
                .computeHelper=${(entry: { name: string }) => this.helper(entry.name)}
                @value-changed=${this.cardChanged}
            ></ha-form>
            <div class="title">${this.text("editor.sources")}</div>
            <ha-sortable handle-selector=".handle" draggable-selector=".source" @item-moved=${this.moved}>
                <div class="sources">${sources.map((source, i) => this.renderRow(source, i))}</div>
            </ha-sortable>
            <ha-button appearance="filled" @click=${this.add}>${this.text("editor.add_source")}</ha-button>
        `;
    }

    private renderRow(source: Source, i: number): TemplateResult {
        const type = source.type && SOURCE_TYPES.includes(source.type) ? source.type : null;
        const detail =
            typeof source.layer === "string" && type !== "rainviewer"
                ? source.layer
                : typeof source.source === "string"
                  ? source.source
                  : "";
        const { name, secondary } = rowText(source, detail, type ? this.text(`editor.type_${type}`) : String(source.type ?? ""));
        return html`<div class="source">
            <ha-icon class="handle" icon="mdi:drag"></ha-icon>
            <ha-icon
                class="icon"
                icon=${typeof source.icon === "string" && source.icon ? source.icon : type ? TYPE_ICONS[type] : "mdi:help"}
            ></ha-icon>
            <div class="text">
                <div class="name">${name}</div>
                ${secondary ? html`<div class="secondary">${secondary}</div>` : nothing}
            </div>
            <ha-icon-button .label=${this.text("editor.edit")} @click=${() => (this.editing = i)}
                ><ha-icon icon="mdi:pencil"></ha-icon
            ></ha-icon-button>
            <ha-icon-button .label=${this.text("editor.remove")} @click=${() => this.removeSource(i)}
                ><ha-icon icon="mdi:close"></ha-icon
            ></ha-icon-button>
        </div>`;
    }

    private renderSource(i: number): TemplateResult {
        const source = this.sources()[i];
        const type = source.type && SOURCE_TYPES.includes(source.type) ? source.type : "wms";
        const offer = this.offer(type, source);
        return html`
            <div class="header">
                <ha-icon-button .label=${this.text("editor.back")} @click=${() => (this.editing = null)}
                    ><ha-icon icon="mdi:arrow-left"></ha-icon
                ></ha-icon-button>
                <span class="title">${this.text("editor.source_title").replace("{n}", String(i + 1))}</span>
            </div>
            <ha-form
                .hass=${this.hass}
                .data=${sourceData({ ...source, type })}
                .schema=${this.sourceSchema(type, source, offer)}
                .computeLabel=${(entry: { name: string }) => this.text(`editor.${entry.name}`)}
                .computeHelper=${(entry: { name: string }) => this.sourceHelper(entry.name, type, offer)}
                @value-changed=${(event: CustomEvent<{ value: Record<string, unknown> }>) => this.sourceChanged(i, event)}
            ></ha-form>
        `;
    }

    private cardSchema(): Record<string, unknown>[] {
        return [
            { name: "zone", selector: { entity: { domain: "zone" } } },
            {
                name: "map_style",
                selector: {
                    select: {
                        mode: "dropdown",
                        options: MAP_STYLES.map((value) => ({ value, label: this.text(`editor.map_style_${value}`) })),
                    },
                },
            },
            {
                type: "grid",
                name: "",
                schema: [
                    { name: "zoom", selector: { number: { min: 0, max: MAX_ZOOM, step: 0.5, mode: "box" } } },
                    { name: "region_zoom", selector: { number: { min: 0, max: MAX_ZOOM, step: 0.5, mode: "box" } } },
                    {
                        name: "map_height",
                        selector: { number: { min: MIN_MAP_HEIGHT, max: 1200, step: 10, mode: "box", unit_of_measurement: "px" } },
                    },
                    { name: "speed", selector: { number: { min: 1, max: 120, step: 1, mode: "box", unit_of_measurement: "min/s" } } },
                ],
            },
            ...rowStepSchema(this.config as RowStepConfig, (key) => this.text(key)),
        ];
    }

    private sourceSchema(type: SourceType, source: Source, offer: ServerOffer | null): Record<string, unknown>[] {
        const fields = SOURCE_FIELDS[type];
        const layer = typeof source.layer === "string" ? source.layer : "";
        const choices = (values: string[]) => ({
            select: { mode: "dropdown", custom_value: true, options: values.map((value) => ({ value, label: value })) },
        });
        const selectors: Record<string, unknown> = {
            url: { text: { type: "url" } },
            layer:
                type === "rainviewer"
                    ? {
                          select: {
                              mode: "dropdown",
                              options: RAINVIEWER_LAYERS.map((value) => ({ value, label: this.text(`editor.layer_${value}`) })),
                          },
                      }
                    : offer?.status === "ok" && offer.layers.length
                      ? choices(offer.layers)
                      : TEXT,
            style: offer?.status === "ok" && layer ? choices(this.styles(type, offer, layer)) : TEXT,
            color_scheme: { number: { min: 0, max: 99, step: 1, mode: "box" } },
            history_minutes: minutes(0, 10080),
            opacity: { number: { min: 0.05, max: 1, step: 0.05, mode: "slider" } },
            max_zoom: { number: { min: 0, max: 22, step: 1, mode: "box" } },
            step_minutes: minutes(1, 1440),
            stale_steps: { number: { min: 1, max: 100, step: 1, mode: "box" } },
            delay_minutes: minutes(0, 1440),
            visible_minutes: minutes(1, 10080),
            timeline_marks: { boolean: {} },
            show_legend: { boolean: {} },
            color: TEXT,
            legend: { text: { type: "url" } },
            attribution: TEXT,
            time_property: TEXT,
            source: TEXT,
            time_attribute: TEXT,
        };
        const entry = (name: string) => ({ name, selector: selectors[name] });
        return [
            {
                name: "type",
                selector: {
                    select: {
                        mode: "dropdown",
                        options: SOURCE_TYPES.map((value) => ({ value, label: this.text(`editor.type_${value}`) })),
                    },
                },
            },
            {
                type: "grid",
                name: "",
                schema: [
                    { name: "name", selector: TEXT },
                    { name: "icon", selector: { icon: {} } },
                ],
            },
            ...fields.main.map(entry),
            {
                type: "expandable",
                name: "advanced",
                title: this.text("editor.advanced"),
                flatten: true,
                schema: fields.advanced.map(entry),
            },
        ];
    }

    /**
     * What a WMS or WMTS source's server offers, read once its address is given, so its layers and styles can be picked
     * from a list. A server that can't be read, such as one that refuses other origins, leaves them to be typed.
     */
    private offer(type: SourceType, source: Source): ServerOffer | null {
        const url = typeof source.url === "string" ? source.url.trim() : "";
        if ((type !== "wms" && type !== "wmts") || !/^https?:\/\/\S+$/.test(url)) return null;
        const key = `${type}|${url}`;
        const known = this.servers.get(key);
        if (known) return known;
        // Read only once the address has stayed as it is for a moment, not at each key typed into it.
        if (this.waiting?.key !== key) {
            clearTimeout(this.waiting?.timer);
            this.waiting = { key, timer: setTimeout(() => this.readServer(type, url, key), READ_DELAY_MS) };
        }
        return null;
    }

    private readServer(type: SourceType, url: string, key: string): void {
        const offer: ServerOffer = { status: "loading", layers: [], xml: "", styles: new Map() };
        this.servers = new Map(this.servers).set(key, offer);
        void fetch(type === "wms" ? capabilitiesUrl(url) : url)
            .then((response) => (response.ok ? response.text() : Promise.reject(new Error(String(response.status)))))
            .then((xml) => {
                const layers = (type === "wms" ? listWmsLayers(xml) : listWmtsLayers(xml)).sort((a, b) => a.localeCompare(b));
                this.servers = new Map(this.servers).set(key, { ...offer, status: layers.length ? "ok" : "failed", layers, xml });
            })
            .catch(() => {
                this.servers = new Map(this.servers).set(key, { ...offer, status: "failed" });
            });
    }

    private styles(type: SourceType, offer: ServerOffer, layer: string): string[] {
        let styles = offer.styles.get(layer);
        if (!styles) {
            try {
                styles = (type === "wms" ? readCapabilities(offer.xml, layer) : readWmtsCapabilities(offer.xml, layer)).styles.map(
                    (style) => style.name,
                );
            } catch {
                styles = [];
            }
            offer.styles.set(layer, styles);
        }
        return styles;
    }

    private sourceHelper(name: string, type: SourceType, offer: ServerOffer | null): string | undefined {
        if (name === "layer" && offer) {
            if (offer.status === "loading") return this.text("editor.layer_loading");
            if (offer.status === "failed") return this.text("editor.layer_failed");
            return this.text("editor.layer_found").replace("{n}", String(offer.layers.length));
        }
        return this.helper(`${name}_${type}`) ?? this.helper(name);
    }

    private sources(): Source[] {
        return (Array.isArray(this.config.sources) ? this.config.sources : []).map((entry: unknown) =>
            typeof entry === "object" && entry !== null ? (entry as Source) : {},
        );
    }

    private cardChanged(event: CustomEvent<{ value: Record<string, unknown> }>): void {
        const config = tidyRowStep(withoutDefaults(event.detail.value, CARD_DEFAULTS)) as Record<string, unknown>;
        config.type = this.config.type ?? "custom:map-timeline-card";
        config.sources = this.sources();
        this.save(config);
    }

    private sourceChanged(i: number, event: CustomEvent<{ value: Record<string, unknown> }>): void {
        const sources = this.sources();
        sources[i] = sourceFromForm({ ...event.detail.value }, sources[i]);
        this.save({ ...this.config, sources });
    }

    private add(): void {
        const sources = [...this.sources(), { type: "wms" as SourceType }];
        this.save({ ...this.config, sources });
        this.editing = sources.length - 1;
    }

    private removeSource(i: number): void {
        this.save({ ...this.config, sources: this.sources().filter((_, j) => j !== i) });
    }

    private moved(event: CustomEvent<{ oldIndex: number; newIndex: number }>): void {
        event.stopPropagation();
        const sources = this.sources();
        const [source] = sources.splice(event.detail.oldIndex, 1);
        sources.splice(event.detail.newIndex, 0, source);
        this.save({ ...this.config, sources });
    }

    private save(config: Record<string, unknown>): void {
        this.config = config;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
    }

    private text(key: string): string {
        return translate(this.hass?.locale?.language ?? this.hass?.language ?? browserLanguage(), key);
    }

    private helper(name: string): string | undefined {
        const key = `editor.${name}_helper`;
        const helper = this.text(key);
        return helper === key ? undefined : helper;
    }

    static styles = css`
        .title {
            font-size: 16px;
            font-weight: 500;
            margin: 24px 0 8px;
        }
        .sources {
            display: flex;
            flex-direction: column;
            gap: 4px;
            margin-bottom: 12px;
        }
        .source {
            display: flex;
            align-items: center;
            gap: 8px;
            border: 1px solid var(--divider-color);
            border-radius: var(--ha-card-border-radius, 12px);
            padding: 2px 4px 2px 8px;
        }
        .handle {
            cursor: grab;
            color: var(--secondary-text-color);
        }
        .icon {
            color: var(--state-icon-color, var(--primary-color));
        }
        .text {
            flex: 1;
            min-width: 0;
        }
        .name,
        .secondary {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .secondary {
            font-size: 12px;
            color: var(--secondary-text-color);
        }
        .header {
            display: flex;
            align-items: center;
            gap: 4px;
            margin: -8px 0 8px -12px;
        }
        .header .title {
            margin: 0;
        }
    `;
}

declare global {
    interface HTMLElementTagNameMap {
        "map-timeline-card-editor": MapTimelineCardEditor;
    }
}

// A copy loaded twice, such as one installed by hand beside the Marketplace's, registers only once.
if (!customElements.get("map-timeline-card-editor")) customElements.define("map-timeline-card-editor", MapTimelineCardEditor);
