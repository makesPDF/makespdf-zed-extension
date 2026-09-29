// User settings, mirroring the VS Code plugin's `makespdf.*` settings with the
// same names, enums and defaults. Zed passes `lsp.makespdf.settings` through as
// the `makespdf` workspace-configuration section; everything here merges over
// the defaults and drops values the server would reject.

export interface MakesPdfSettings {
  serviceUrl: string;
  /** Empty when no key is configured: requests then go anonymously. */
  apiToken: string;
  pageSize: PageSize;
  fontFamily: FontFamily;
  fontSize: number;
  /** [top, right, bottom, left] in points. */
  margins: number[];
}

export const PAGE_SIZES = ["A3", "A4", "A5", "Letter", "Legal"] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export const FONT_FAMILIES = ["Inter", "NotoSans"] as const;
export type FontFamily = (typeof FONT_FAMILIES)[number];

export const DEFAULT_SETTINGS: MakesPdfSettings = {
  serviceUrl: "https://makespdf.com",
  apiToken: "",
  pageSize: "A4",
  fontFamily: "Inter",
  fontSize: 10,
  margins: [40, 40, 40, 40],
};

function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function positiveIntInRange(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
    ? value
    : undefined;
}

function validMargins(value: unknown): number[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every((m) => typeof m === "number" && Number.isFinite(m) && m >= 0)
  ) {
    return undefined;
  }
  return value as number[];
}

/**
 * Merge a raw configuration object over the defaults. Every field falls back
 * individually, so one bad setting costs that setting, not the whole set.
 */
export function mergeSettings(incoming: unknown): MakesPdfSettings {
  const raw = (incoming && typeof incoming === "object" ? incoming : {}) as Record<
    string,
    unknown
  >;

  const serviceUrl =
    typeof raw.serviceUrl === "string" && raw.serviceUrl.trim()
      ? raw.serviceUrl.trim()
      : DEFAULT_SETTINGS.serviceUrl;

  return {
    serviceUrl,
    apiToken: typeof raw.apiToken === "string" ? raw.apiToken.trim() : DEFAULT_SETTINGS.apiToken,
    pageSize: isOneOf(raw.pageSize, PAGE_SIZES) ? raw.pageSize : DEFAULT_SETTINGS.pageSize,
    fontFamily: isOneOf(raw.fontFamily, FONT_FAMILIES)
      ? raw.fontFamily
      : DEFAULT_SETTINGS.fontFamily,
    fontSize:
      positiveIntInRange(raw.fontSize, 6, 24) ?? DEFAULT_SETTINGS.fontSize,
    margins: validMargins(raw.margins) ?? DEFAULT_SETTINGS.margins,
  };
}
