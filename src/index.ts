/**
 * PRISM plugin module entry point.
 *
 * Renders post-session health diagnostics for the selected project (or an
 * all-projects overview when none is selected). Data comes from the plugin
 * backend, which shells out to the locally installed `prism` CLI.
 */

import type { PluginAPI, PluginContext } from './types.js';

// ── Types (mirror the backend response) ────────────────────────────────

interface Dimension {
  grade: string;
  score: number;
}

interface Issue {
  severity: string;
  category: string;
  description: string;
}

interface Report {
  project: string;
  display_name: string;
  session_count: number;
  overall_grade: string;
  overall_score: number;
  dimensions: Record<string, Dimension>;
  top_issues: Issue[];
}

interface Health {
  installed: boolean;
  version: string | null;
}

interface ReportCache {
  projectPath: string | null;
  reports: Report[];
}

// ── Constants ──────────────────────────────────────────────────────────

// Font stacks match the CloudCLI host, which already loads these faces.
// Font stacks match the CloudCLI host, which already loads these faces.
// Single quotes only: these are interpolated into style="..." attributes.
const SANS = "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const MONO = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
const SERIF = "'Source Serif 4', Georgia, Cambria, 'Times New Roman', serif";

const DIMENSIONS: [string, string][] = [
  ['token_efficiency', 'token efficiency'],
  ['tool_health', 'tool health'],
  ['context_hygiene', 'context hygiene'],
  ['claude_md_adherence', 'claude.md adherence'],
  ['session_continuity', 'session continuity'],
];

// ── Theme helpers ──────────────────────────────────────────────────────

// Every colour resolves through a --prism-* variable defined in THEME_CSS,
// which reads the host's HSL-triplet variables (hsl(var(--background))) and
// falls back to the host's default values when a variable is missing. The
// --prism- prefix keeps these from shadowing the host's own variables.

interface ThemeColors {
  bg: string;
  surface: string;
  sunken: string;
  border: string;
  track: string;
  text: string;
  muted: string;
  accent: string;
  dim: string;
  link: string;
  success: string;
  info: string;
  warning: string;
  caution: string;
  danger: string;
}

const COLORS: ThemeColors = {
  bg: 'var(--prism-bg)',
  surface: 'var(--prism-surface)',
  sunken: 'var(--prism-sunken)',
  border: 'var(--prism-border)',
  track: 'var(--prism-track)',
  text: 'var(--prism-text)',
  muted: 'var(--prism-muted)',
  accent: 'var(--prism-accent)',
  dim: 'var(--prism-dim)',
  link: 'var(--prism-link)',
  success: 'var(--prism-success)',
  info: 'var(--prism-info)',
  warning: 'var(--prism-warning)',
  caution: 'var(--prism-caution)',
  danger: 'var(--prism-danger)',
};

const RADIUS = 'var(--prism-radius)';
const RADIUS_MD = 'calc(var(--prism-radius) - 2px)';
const RADIUS_SM = 'calc(var(--prism-radius) - 4px)';

// Lucide icons, drawn inline so the tab makes no requests of its own.
// PRISM_ICON matches icon.svg, which the host shows in the tab bar.
const PRISM_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4 3.5 19h17L12 4Z"/><path d="M2 11.5h4.5"/><path d="M16 10.5l5.5-2"/><path d="M17.5 13.5H22"/><path d="M18.5 16.5l3.5 1.5"/></svg>';
const REFRESH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>';

// Host fallbacks per mode; the plugin root carries data-theme from ctx.theme.
// Status hues (success/info/warning/caution) have no host variable, so they
// are tuned here to keep at least 4.5:1 against --card and --background.
const THEME_CSS = `
  .prism-root {
    --prism-bg: hsl(var(--background, 60 14.3% 98.6%));
    --prism-surface: hsl(var(--card, 0 0% 100%));
    --prism-sunken: hsl(var(--muted, 60 3.2% 93.9%));
    --prism-border: hsl(var(--border, 60 1.7% 88.4%));
    --prism-track: hsl(var(--muted-foreground, 50 2.9% 40.8%) / 0.2);
    --prism-text: hsl(var(--foreground, 60 2.6% 7.6%));
    --prism-muted: hsl(var(--muted-foreground, 50 2.9% 40.8%));
    --prism-accent: hsl(var(--primary, 15.5 58.2% 43.1%));
    --prism-dim: hsl(var(--primary, 15.5 58.2% 43.1%) / 0.08);
    --prism-ring: hsl(var(--ring, 15.1 55.6% 52.4%));
    --prism-link: hsl(var(--link, 218.4 61.3% 43.5%));
    --prism-danger: hsl(var(--destructive, 4.1 59.1% 44.1%));
    --prism-success: hsl(152 60% 28%);
    --prism-info: hsl(192 80% 29%);
    --prism-warning: hsl(36 90% 32%);
    --prism-caution: hsl(22 80% 38%);
    --prism-input: hsl(var(--input, 60 1.5% 87.3%));
    --prism-hover: hsl(var(--accent, 48 12.2% 92%));
    --prism-radius: var(--radius, 0.625rem);
  }
  .prism-root[data-theme="dark"] {
    --prism-bg: hsl(var(--background, 0 0% 8.2%));
    --prism-surface: hsl(var(--card, 60 1.6% 12.4%));
    --prism-sunken: hsl(var(--muted, 0 0% 12.9%));
    --prism-border: hsl(var(--border, 0 1.2% 15.9%));
    --prism-track: hsl(var(--muted-foreground, 45 3.6% 56.1%) / 0.22);
    --prism-text: hsl(var(--foreground, 45 11.8% 93.3%));
    --prism-muted: hsl(var(--muted-foreground, 45 3.6% 56.1%));
    --prism-accent: hsl(var(--primary, 15.2 64.9% 63.1%));
    --prism-dim: hsl(var(--primary, 15.2 64.9% 63.1%) / 0.12);
    --prism-ring: hsl(var(--ring, 15.2 64.9% 63.1%));
    --prism-link: hsl(var(--link, 217.1 88.7% 75.7%));
    --prism-danger: hsl(var(--destructive, 9.9 72.5% 67.3%));
    --prism-success: hsl(150 45% 58%);
    --prism-info: hsl(190 55% 60%);
    --prism-warning: hsl(40 75% 60%);
    --prism-caution: hsl(24 80% 66%);
    --prism-input: hsl(var(--input, 30 1.9% 21.2%));
    --prism-hover: hsl(var(--accent, 0 1.2% 16.7%));
  }
  .prism-top { position: sticky; top: 0; z-index: 1; background: var(--prism-bg); }
  .prism-header {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 12px 16px; border-bottom: 1px solid color-mix(in srgb, var(--prism-border) 60%, transparent);
  }
  .prism-heading { flex: 1; min-width: 0; }
  .prism-title-row { display: flex; align-items: center; gap: 8px; }
  .prism-title-row svg { flex: none; width: 16px; height: 16px; color: var(--prism-accent); }
  .prism-header h2 { margin: 0; font-size: 14px; font-weight: 600; line-height: 20px; }
  .prism-header p { margin: 2px 0 0; color: var(--prism-muted); font-size: 12px; overflow-wrap: anywhere; }
  .prism-header p code { font-family: ${MONO}; font-size: 11.5px; }
  .prism-actions { flex: none; display: flex; align-items: center; gap: 6px; }
  .prism-icon-btn {
    appearance: none; display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; padding: 0; border: 1px solid transparent; background: transparent;
    color: var(--prism-text); border-radius: ${RADIUS_MD}; cursor: pointer; transition: background-color 0.15s;
  }
  .prism-icon-btn svg { width: 14px; height: 14px; }
  .prism-icon-btn:focus-visible { outline: none; box-shadow: 0 0 0 1px var(--prism-ring); }
  .prism-icon-btn:disabled { opacity: 0.5; cursor: default; }
  .prism-refreshing svg { animation: prism-spin 0.8s linear infinite; }
  .prism-strip {
    display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; padding: 8px 16px;
    font-size: 12px; color: var(--prism-muted);
    border-bottom: 1px solid color-mix(in srgb, var(--prism-border) 60%, transparent);
    background: color-mix(in srgb, var(--prism-sunken) 20%, var(--prism-bg));
  }
  .prism-stat b { color: var(--prism-text); font-weight: 600; margin-left: 4px; }
  .prism-strip-end { margin-left: auto; }
  .prism-banner {
    padding: 8px 16px; font-size: 12px; color: var(--prism-danger);
    border-bottom: 1px solid color-mix(in srgb, var(--prism-danger) 20%, transparent);
    background: color-mix(in srgb, var(--prism-danger) 10%, var(--prism-bg));
  }
  .prism-content { padding: 12px 16px 32px; }
  .prism-row { display: flex; align-items: center; gap: 12px; margin-bottom: 9px; }
  .prism-dim-label { width: 160px; flex-shrink: 0; font-size: 12px; color: var(--prism-muted); }
  .prism-num { width: 42px; flex-shrink: 0; text-align: right; font-family: ${MONO}; font-size: 11.5px; color: var(--prism-muted); }
  .prism-proj-name { flex: 1; min-width: 0; font-size: 12.5px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .prism-proj-sess { width: 70px; flex-shrink: 0; text-align: right; font-size: 12px; color: var(--prism-muted); white-space: nowrap; }
  .prism-proj-bar { width: 120px; flex-shrink: 0; display: flex; }
  .prism-issue { display: flex; gap: 10px; align-items: baseline; padding: 7px 0; font-size: 12.5px; line-height: 1.5; }
  .prism-overall { display: flex; align-items: center; gap: 20px; }
  .prism-overall-grade { font-family: ${SERIF}; font-size: 2.6rem; font-weight: 600; letter-spacing: -0.02em; line-height: 1; min-width: 68px; text-align: center; }
  @media (hover: hover) {
    .prism-icon-btn:not(:disabled):hover { background: var(--prism-hover); }
    .prism-link:hover { text-decoration: underline; }
  }
  /* Breakpoints are container queries: the tab is often narrower than the
     screen (sidebar open, iPad split view), as in the Usage tab. */
  @container (max-width: 560px) {
    .prism-header { padding: 12px 12px 12px 16px; }
    .prism-content { padding: 12px 12px 24px; }
    .prism-row { gap: 10px; }
    .prism-dim-label { width: 124px; }
    .prism-num { width: 28px; }
    .prism-proj-sess { width: auto; }
    .prism-proj-bar { width: 72px; }
    .prism-issue { flex-wrap: wrap; row-gap: 2px; }
    .prism-issue-desc { flex-basis: 100%; }
    .prism-overall { gap: 14px; }
    .prism-overall-grade { font-size: 2.2rem; min-width: 52px; }
  }
  @container (max-width: 360px) {
    .prism-proj-bar { display: none; }
  }
  @keyframes prism-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .prism-refreshing svg { animation: none; } }
  .prism-link { color: var(--prism-link); text-decoration: none; }
  .prism-link:focus-visible { outline: 2px solid var(--prism-ring); outline-offset: 2px; border-radius: ${RADIUS_SM}; }
`;

function themeColors(): ThemeColors {
  return COLORS;
}

function gradeColor(grade: string, c: ThemeColors): string {
  switch (grade.charAt(0)) {
    case 'A': return c.success;
    case 'B': return c.info;
    case 'C': return c.warning;
    case 'D': return c.caution;
    case 'F': return c.danger;
    default: return c.muted; // N/A
  }
}

function severityColor(severity: string, c: ThemeColors): string {
  switch (severity.toLowerCase()) {
    case 'high': return c.danger;
    case 'medium': return c.warning;
    default: return c.muted;
  }
}

// ── Utility helpers ────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ensureAssets(): void {
  if (document.getElementById('prism-styles')) return;

  const s = document.createElement('style');
  s.id = 'prism-styles';
  s.textContent = `
    @keyframes prism-grow   { from { width: 0 } }
    @keyframes prism-fadeup { from { opacity:0; transform:translateY(6px) } to { opacity:1; transform:translateY(0) } }
    @keyframes prism-pulse  { 0%,100% { opacity:.3 } 50% { opacity:.6 } }
    .prism-bar  { animation: prism-grow   0.75s cubic-bezier(.16,1,.3,1) both }
    .prism-up   { animation: prism-fadeup 0.4s  ease both }
    .prism-skel { animation: prism-pulse  1.6s  ease infinite }
    ${THEME_CSS}
  `;
  document.head.appendChild(s);
}

// Home directories shorten to ~, as in the Agents tab.
function shortPath(path: string): string {
  return path.replace(/^(\/home\/[^/]+|\/Users\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/, '~');
}

function skeletonRows(c: ThemeColors, widths: number[]): string {
  return widths
    .map(
      (w, i) => `
    <div class="prism-skel" style="
      height:10px;width:${w}%;background:${c.muted};border-radius:${RADIUS_SM};
      margin-bottom:8px;animation-delay:${i * 0.1}s
    "></div>`,
    )
    .join('');
}

function gradeChip(grade: string, c: ThemeColors): string {
  const color = gradeColor(grade, c);
  return `
    <span style="
      display:inline-flex;align-items:center;justify-content:center;min-width:32px;box-sizing:border-box;
      padding:0 6px;line-height:18px;border-radius:${RADIUS_MD};
      border:1px solid color-mix(in srgb, ${color} 30%, transparent);
      background:color-mix(in srgb, ${color} 8%, transparent);
      color:${color};font-size:11px;font-weight:600;white-space:nowrap;
    ">${esc(grade)}</span>`;
}

function scoreBar(score: number, grade: string, c: ThemeColors, delay: number): string {
  const width = Math.max(0, Math.min(100, Math.round(score)));
  return `
    <div style="flex:1;height:4px;background:${c.track};border-radius:${RADIUS};overflow:hidden">
      <div class="prism-bar" style="
        height:100%;width:${width}%;background:${gradeColor(grade, c)};
        animation-delay:${delay}s;border-radius:${RADIUS};
      "></div>
    </div>`;
}

// ── Mount / Unmount ────────────────────────────────────────────────────

export function mount(container: HTMLElement, api: PluginAPI): void {
  ensureAssets();
  let cache: ReportCache | null = null;
  let health: Health | null = null;

  const root = document.createElement('div');
  root.className = 'prism-root';
  Object.assign(root.style, {
    height: '100%',
    overflowY: 'auto',
    boxSizing: 'border-box',
    fontFamily: SANS,
    containerType: 'inline-size',
  });
  container.appendChild(root);

  function paint(ctx: PluginContext): void {
    const c = themeColors();
    root.dataset.theme = ctx.theme === 'dark' ? 'dark' : 'light';
    root.style.background = c.bg;
    root.style.color = c.text;
  }

  function subtitle(ctx: PluginContext): string {
    if (!ctx.project) return 'Session health across all projects · select one for the full report';
    const path = ctx.project.path;
    return `Session health for <code title="${esc(path)}">${esc(shortPath(path))}</code>`;
  }

  // Header bar laid out like the host's Browser tab and the Agents plugin: icon,
  // title and subtitle on the left, an icon-only refresh on the right, and an
  // optional strip of counts underneath. It stays put while the content scrolls.
  function top(
    ctx: PluginContext,
    opts: { refresh?: 'idle' | 'busy'; stats?: [string, string, string?][]; end?: string; banner?: string },
  ): string {
    const refresh = opts.refresh
      ? `<button id="prism-refresh" class="prism-icon-btn${opts.refresh === 'busy' ? ' prism-refreshing' : ''}"
           title="Refresh" aria-label="Refresh"${opts.refresh === 'busy' ? ' disabled' : ''}>${REFRESH_ICON}</button>`
      : '';
    const strip = opts.stats
      ? `<div class="prism-strip">
          ${opts.stats
            .map(([label, value, color]) => `<span class="prism-stat">${label}<b${color ? ` style="color:${color}"` : ''}>${value}</b></span>`)
            .join('')}
          ${opts.end ? `<span class="prism-strip-end">${opts.end}</span>` : ''}
        </div>`
      : '';
    const banner = opts.banner ? `<div class="prism-banner" role="alert">${opts.banner}</div>` : '';
    return `
      <div class="prism-top">
        <header class="prism-header">
          <div class="prism-heading">
            <div class="prism-title-row">${PRISM_ICON}<h2>Prism</h2></div>
            <p>${subtitle(ctx)}</p>
          </div>
          <div class="prism-actions">${refresh}</div>
        </header>
        ${strip}${banner}
      </div>`;
  }

  function versionLabel(): string {
    return health?.version ? `prism v${esc(health.version)}` : '';
  }

  function bindRefresh(): void {
    root.querySelector('#prism-refresh')?.addEventListener('click', () => {
      cache = null;
      load(api.context);
    });
  }

  function sectionLabel(c: ThemeColors, text: string): string {
    return `<div style="font-size:11px;font-weight:500;color:${c.muted};letter-spacing:0.04em;text-transform:uppercase;margin-bottom:12px">${text}</div>`;
  }

  function card(c: ThemeColors, body: string, extra = ''): string {
    return `<div class="prism-up" style="background:${c.surface};border:1px solid ${c.border};border-radius:${RADIUS};padding:14px 16px;margin-bottom:12px;${extra}">${body}</div>`;
  }

  function renderNotInstalled(ctx: PluginContext): void {
    const c = themeColors();
    paint(ctx);
    root.innerHTML = `
      ${top(ctx, {})}
      <div class="prism-content">
        <div class="prism-up" style="display:flex;flex-direction:column;align-items:center;text-align:center;gap:12px;padding:48px 16px">
          <div style="font-size:14px;font-weight:600">PRISM is not installed</div>
          <div style="font-size:12px;color:${c.muted}">Install the <code style="font-family:${MONO};font-size:11.5px">prism</code> command, then reopen this tab.</div>
          <div style="
            background:${c.sunken};border:1px solid ${c.border};border-radius:${RADIUS_MD};
            padding:10px 16px;font-family:${MONO};font-size:12px;color:${c.text};
          ">pip install prism-cc</div>
          <a class="prism-link" href="https://github.com/jakeefr/prism" target="_blank" rel="noreferrer" style="font-size:12px">github.com/jakeefr/prism →</a>
        </div>
      </div>`;
  }

  function renderError(ctx: PluginContext, message: string): void {
    paint(ctx);
    root.innerHTML = top(ctx, { banner: esc(message) });
  }

  function renderLoading(ctx: PluginContext): void {
    const c = themeColors();
    paint(ctx);
    root.innerHTML = `
      ${top(ctx, { refresh: 'busy', stats: [], end: 'Analyzing sessions…' })}
      <div class="prism-content">
        ${card(c, skeletonRows(c, [30, 70, 55, 62, 48, 40]))}
        ${card(c, skeletonRows(c, [80, 65, 50]))}
      </div>`;
  }

  function renderReport(ctx: PluginContext, report: Report): void {
    const c = themeColors();
    paint(ctx);
    const overallColor = gradeColor(report.overall_grade, c);
    const highCount = report.top_issues.filter((i) => i.severity.toLowerCase() === 'high').length;

    root.innerHTML = `
      ${top(ctx, {
        refresh: 'idle',
        stats: [
          ['Sessions', String(Number(report.session_count))],
          ['Score', Number(report.overall_score).toFixed(1)],
          ['Issues', String(report.top_issues.length)],
          ['High', String(highCount), highCount > 0 ? c.danger : undefined],
        ],
        end: versionLabel(),
      })}
      <div class="prism-content">
        ${card(c, `
          <div class="prism-overall">
            <div class="prism-overall-grade" style="color:${overallColor}">${esc(report.overall_grade)}</div>
            <div style="flex:1;min-width:0">
              <div style="display:flex;justify-content:space-between;gap:12px;font-size:11px;color:${c.muted};margin-bottom:8px">
                <span style="font-weight:500;letter-spacing:0.04em;text-transform:uppercase">overall health</span>
                <span style="font-family:${MONO}">${Number(report.overall_score).toFixed(1)} / 100</span>
              </div>
              ${scoreBar(report.overall_score, report.overall_grade, c, 0.1)}
            </div>
          </div>`)}

        ${card(c, `
          ${sectionLabel(c, 'dimensions')}
          ${DIMENSIONS.map(([key, label], i) => {
            const dim = report.dimensions[key];
            if (!dim) return '';
            return `
            <div class="prism-up prism-row" style="animation-delay:${0.12 + i * 0.04}s">
              <div class="prism-dim-label">${label}</div>
              ${scoreBar(dim.score, dim.grade, c, 0.15 + i * 0.04)}
              <div class="prism-num">${Number(dim.score).toFixed(0)}</div>
              ${gradeChip(dim.grade, c)}
            </div>`;
          }).join('')}`, 'animation-delay:0.08s')}

        ${card(c, `
          ${sectionLabel(c, 'top issues')}
          ${
            report.top_issues.length === 0
              ? `<div style="font-size:12px;color:${c.muted}">none found</div>`
              : report.top_issues
                  .map(
                    (issue, i) => `
              <div class="prism-up prism-issue" style="
                border-top:${i === 0 ? '0' : `1px solid ${c.border}`};animation-delay:${0.2 + i * 0.04}s;
              ">
                <span style="
                  flex-shrink:0;font-size:11px;font-weight:600;letter-spacing:0.04em;
                  text-transform:uppercase;color:${severityColor(issue.severity, c)};
                ">${esc(issue.severity)}</span>
                <span style="flex-shrink:0;font-family:${MONO};font-size:11.5px;color:${c.muted}">${esc(issue.category)}</span>
                <span class="prism-issue-desc">${esc(issue.description)}</span>
              </div>`,
                  )
                  .join('')
          }`, 'animation-delay:0.16s')}
      </div>
    `;
    bindRefresh();
  }

  function renderOverview(ctx: PluginContext, reports: Report[]): void {
    const c = themeColors();
    paint(ctx);
    const sorted = [...reports].sort((a, b) => a.overall_score - b.overall_score);
    const sessions = reports.reduce((n, r) => n + Number(r.session_count), 0);
    const attention = reports.filter((r) => /^[DF]/.test(r.overall_grade)).length;

    root.innerHTML = `
      ${top(ctx, {
        refresh: 'idle',
        stats: [
          ['Projects', String(reports.length)],
          ['Sessions', String(sessions)],
          ['Need attention', String(attention), attention > 0 ? c.warning : undefined],
        ],
        end: versionLabel(),
      })}
      <div class="prism-content">
        ${card(c, `
          ${sectionLabel(c, 'worst first')}
          ${
            sorted.length === 0
              ? `<div style="font-size:12px;color:${c.muted}">no projects with session data found</div>`
              : sorted
                  .map(
                    (r, i) => `
            <div class="prism-up prism-row" style="animation-delay:${0.1 + i * 0.03}s">
              <div class="prism-proj-name" title="${esc(r.display_name)}">${esc(r.display_name)}</div>
              <div class="prism-proj-sess">${Number(r.session_count)} sess</div>
              <div class="prism-proj-bar">
                ${scoreBar(r.overall_score, r.overall_grade, c, 0.12 + i * 0.03)}
              </div>
              <div class="prism-num">${Number(r.overall_score).toFixed(0)}</div>
              ${gradeChip(r.overall_grade, c)}
            </div>`,
                  )
                  .join('')
          }`, 'animation-delay:0.06s')}
      </div>
    `;
    bindRefresh();
  }

  function renderNoData(ctx: PluginContext): void {
    const c = themeColors();
    paint(ctx);
    root.innerHTML = `
      ${top(ctx, { refresh: 'idle', stats: [['Sessions', '0']], end: versionLabel() })}
      <div class="prism-content">
        <div class="prism-up" style="text-align:center;padding:48px 16px;color:${c.muted};font-size:12.5px;line-height:1.6">
          <div style="color:${c.text};font-size:14px;font-weight:600;margin-bottom:4px">No session data yet</div>
          PRISM has no recorded Claude Code sessions for this project.<br>
          Run a session here, then refresh.
        </div>
      </div>`;
    bindRefresh();
  }

  function renderFromCache(ctx: PluginContext): void {
    if (!cache) return;
    if (cache.projectPath) {
      if (cache.reports[0]) renderReport(ctx, cache.reports[0]);
      else renderNoData(ctx);
    } else {
      renderOverview(ctx, cache.reports);
    }
  }

  async function load(ctx: PluginContext): Promise<void> {
    renderLoading(ctx);
    try {
      if (!health) {
        health = (await api.rpc('GET', 'health')) as Health;
      }
      if (!health.installed) {
        renderNotInstalled(ctx);
        return;
      }
      const projectPath = ctx.project?.path ?? null;
      const query = projectPath ? `report?path=${encodeURIComponent(projectPath)}` : 'report';
      const { reports } = (await api.rpc('GET', query)) as { reports: Report[] };
      cache = { projectPath, reports };
      renderFromCache(ctx);
    } catch (err) {
      renderError(ctx, (err as Error).message);
    }
  }

  load(api.context);

  const unsubscribe = api.onContextChange((ctx) => {
    const projectPath = ctx.project?.path ?? null;
    if (cache && cache.projectPath === projectPath) renderFromCache(ctx);
    else load(ctx);
  });

  (container as any)._prismUnsubscribe = unsubscribe;
}

export function unmount(container: HTMLElement): void {
  if (typeof (container as any)._prismUnsubscribe === 'function') {
    (container as any)._prismUnsubscribe();
    delete (container as any)._prismUnsubscribe;
  }
  container.innerHTML = '';
}
