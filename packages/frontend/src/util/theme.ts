import {Theme} from '@agent-storm/common';
import {applyColorThemeViaStyleElement} from 'theme-vir';
import {viraTheme, viraThemeDarkOverride} from 'vira';

const prefersDarkQuery = '(prefers-color-scheme: dark)';

/**
 * Whether the Claude-modeled dark styling should be active for a given config value. `DarkClaude`
 * is always dark; `Auto` follows the OS; everything else (including `Light` and an absent/legacy
 * value) is light. Shared so the favicon swap here and the terminal palette agree on "is
 * dark-claude active".
 */
export function resolveIsDarkClaude(theme: Theme | undefined): boolean {
    if (theme === Theme.DarkClaude) {
        return true;
    } else if (theme === Theme.Auto) {
        return globalThis.matchMedia(prefersDarkQuery).matches;
    }
    return false;
}

/**
 * Browser-tab / PWA favicon links to swap between electrovir's original icon and the Claude icon.
 * Light mode leaves the original `href`s from `index.html` in place (the original app, untouched);
 * dark-claude points them at the `claude-*` variants. (The web-app-manifest icons can't be swapped
 * at runtime, so an installed PWA keeps whatever icon it was installed with.)
 */
const faviconSwaps: ReadonlyArray<{selector: string; light: string; dark: string}> = [
    {
        selector: 'link[rel="icon"][type="image/png"]',
        light: '/favicon-96x96.png',
        dark: '/claude-favicon-96x96.png',
    },
    {
        selector: 'link[rel="icon"][type="image/svg+xml"]',
        light: '/favicon.svg',
        dark: '/claude-favicon.svg',
    },
    {
        selector: 'link[rel="shortcut icon"]',
        light: '/favicon.ico',
        dark: '/claude-favicon.ico',
    },
    {
        selector: 'link[rel="apple-touch-icon"]',
        light: '/apple-touch-icon.png',
        dark: '/claude-apple-touch-icon.png',
    },
];

function setFavicons(useClaude: boolean): void {
    for (const {selector, light, dark} of faviconSwaps) {
        const link = document.querySelector<HTMLLinkElement>(selector);
        if (link) {
            link.href = useClaude ? dark : light;
        }
    }
}

/**
 * Background color used by the terminal (xterm) panes per mode. Shared between the xterm `ITheme`
 * (in `vir-terminal`) and the `--terminal-host-bg` CSS var set here, so the canvas background and
 * the host element's padding stay in sync. Kept here (not in `vir-terminal`) so the theme appliers
 * below can set the var without importing the terminal element.
 */
export const terminalThemeBackground = {
    light: '#ffffff',
    dark: '#1b1a18',
} as const;

/**
 * Background for the currently-active sidebar row. Claude's desktop app marks the selected item
 * with a subtly _lighter_ dark grey rather than a colored tint, so this sits a step above the
 * chrome default (`claudeDarkDefault.background`) while staying clearly "dark grey". Driven as a
 * CSS var so light mode falls back to vira's stock tint.
 */
const activeRowBackgroundDark = '#34332f';

/**
 * Warm Claude-style values for vira's page-default color pair in dark mode. The chrome surface
 * (`--vira-default-bg`) is intentionally a touch lighter than the terminal background
 * ({@link terminalThemeBackground}`.dark`) so the terminal panes read as inset. `vira` itself only
 * paints this default on its own components (modals, etc.); the app root binds to it too (see
 * `vir-app`'s `:host`) so every transparent surface — sidebar, tab strip — follows the theme.
 */
const claudeDarkDefault = {
    background: '#262624',
    foreground: '#edece8',
} as const;

/**
 * Clay-rotated replacement for vira's base `green` color scale (`--vira-green-{step}`). vira maps
 * the "Positive" button variant to its green family, and every green color pair
 * (`vira-green-*-fg/-bg`) resolves down to one of these base steps — so overriding the base scale
 * recolors every Positive button (sidebar/settings "+") plus anything else keyed to green, in both
 * light and dark mode, with far fewer vars than the per-pair approach and no runtime color math.
 *
 * Each value is the corresponding vira green step rotated onto Claude's clay hue (~18°) while
 * keeping that step's original lightness, so the ramp's light→dark contrast structure is preserved.
 * The comments record the original green for reference. See the generation note in MEMORY if these
 * need regenerating against a future vira version.
 */
const clayGreenScale: Readonly<Record<string, string>> = {
    '--vira-green-100': '#fff1eb', // was #EBFFEE
    '--vira-green-250': '#f6cfbe', // was #BFF5CC
    '--vira-green-300': '#f2c2ad', // was #AFF0C0
    '--vira-green-350': '#eab198', // was #9AE8B1
    '--vira-green-400': '#db997d', // was #7FD99C
    '--vira-green-450': '#cb744f', // was #52C87F
    '--vira-green-500': '#b94817', // was #1BB565
    '--vira-green-550': '#a93300', // was #04A559
    '--vira-green-650': '#8c2a00', // was #008C4A
    '--vira-green-700': '#7c2500', // was #007C41
    '--vira-green-750': '#6b2000', // was #016A38
    '--vira-green-800': '#5a2007', // was #095831
    '--vira-green-850': '#4d1700', // was #024B29
    '--vira-green-1000': '#2e1105', // was #062D1B
};

/**
 * Override vira's base green scale with the clay ramp on `documentElement` (`:root`), which the
 * theme's own `:root` stylesheet and all shadow-DOM components inherit. Deterministic — every green
 * pair var resolves down to one of these base steps.
 */
function recolorAccentToClay(): void {
    const root = document.documentElement;
    for (const [
        name,
        value,
    ] of Object.entries(clayGreenScale)) {
        root.style.setProperty(name, value);
    }
}

/** Undo {@link recolorAccentToClay}, restoring vira's stock green scale. */
function clearAccentRecolor(): void {
    const root = document.documentElement;
    for (const name of Object.keys(clayGreenScale)) {
        root.style.removeProperty(name);
    }
}

/** Apply the Claude-modeled dark theme: vira's dark override + the warm surface vars + clay accent. */
function applyDarkClaudeTheme(): void {
    const root = document.documentElement;
    applyColorThemeViaStyleElement(viraTheme, viraThemeDarkOverride);
    /**
     * Drive the terminal host's padding background. `vir-terminal`'s `:host` reads this var; the
     * xterm canvas paints its own (matching) background over the rest. Set on `documentElement` so
     * it crosses the shadow DOM boundary into every terminal instance.
     */
    root.style.setProperty('--terminal-host-bg', terminalThemeBackground.dark);
    /**
     * Warm vira's page-default pair toward Claude's palette. `applyColorThemeViaStyleElement` sets
     * these vars via a `:root` `<style>`; an inline property on `documentElement` (which _is_
     * `:root`) outranks that stylesheet, so this recolors the app root plus every vira color that
     * references the default (its `behind-*` pairs).
     */
    root.style.setProperty('--vira-default-bg', claudeDarkDefault.background);
    root.style.setProperty('--vira-default-fg', claudeDarkDefault.foreground);
    root.style.setProperty('--active-row-bg', activeRowBackgroundDark);
    recolorAccentToClay();
    setFavicons(true);
}

/**
 * Revert everything {@link applyDarkClaudeTheme} did, back to the original light look. Only reached
 * via {@link Theme.Auto} on a dark→light OS switch (no page reload happens in that path). A fixed
 * {@link Theme.Light} selection never calls this — see {@link applyTheme}.
 */
function clearDarkClaudeTheme(): void {
    const root = document.documentElement;
    applyColorThemeViaStyleElement(viraTheme, undefined);
    root.style.removeProperty('--terminal-host-bg');
    root.style.removeProperty('--vira-default-bg');
    root.style.removeProperty('--vira-default-fg');
    root.style.removeProperty('--active-row-bg');
    clearAccentRecolor();
    setFavicons(false);
}

/**
 * Apply the configured theme to the document. Returns a disposer; it only does work for
 * {@link Theme.Auto}, where we subscribe to the OS `prefers-color-scheme` so the app follows the
 * system setting live.
 *
 * `Light` (and an absent/undefined config value, which defaults to light) intentionally touches
 * nothing: the original upstream light theme renders exactly as-is, with none of this fork's vars
 * or style elements injected. Theme changes from the settings modal trigger a full page reload, so
 * there's no stale dark state to clear when landing on light.
 */
export function applyTheme(theme: Theme | undefined): () => void {
    if (theme === Theme.Auto) {
        const media = globalThis.matchMedia(prefersDarkQuery);
        const onChange = () => {
            if (media.matches) {
                applyDarkClaudeTheme();
            } else {
                clearDarkClaudeTheme();
            }
        };
        onChange();
        media.addEventListener('change', onChange);
        return () => media.removeEventListener('change', onChange);
    }

    if (theme === Theme.DarkClaude) {
        applyDarkClaudeTheme();
    }
    return () => {};
}
