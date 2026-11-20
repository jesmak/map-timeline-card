/** The little of Home Assistant a card needs, so the unmaintained custom-card-helpers isn't a dependency. */

export interface HassEntity {
    entity_id: string;
    state: string;
    attributes: Record<string, unknown>;
}

export interface HassConnection {
    sendMessagePromise<T>(message: Record<string, unknown>): Promise<T>;
    addEventListener(event: "ready", listener: () => void): void;
    removeEventListener(event: "ready", listener: () => void): void;
}

export interface HomeAssistant {
    states: Record<string, HassEntity | undefined>;
    connection: HassConnection;
    /** `hassUrl` is where the instance is, which isn't this page's origin when the dashboard is cast. */
    auth?: { data?: { hassUrl?: string } };
    /** `theme` is the default theme; `selectedTheme` the viewer's own choice, null when they follow the default. */
    themes?: { darkMode?: boolean; theme?: string };
    selectedTheme?: { theme?: string } | null;
    /** Where home is, which the map centres on unless a zone is set. */
    config?: { latitude?: number; longitude?: number; time_zone?: string };
    language?: string;
    /** `time_zone` is the user's choice between the browser's zone and the server's. */
    locale?: { language?: string; time_zone?: "local" | "server" };
}
