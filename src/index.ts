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
// Cards match the host's Card: rounded-xl with its soft shadow-sm.
const RADIUS_XL = 'calc(var(--prism-radius) + 4px)';

// Lucide's rotate-cw, the icon set the host's own buttons use.
const REFRESH_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>';

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
    --prism-shadow: 0 1px 2px 0 hsl(var(--shadow-color, 30 6% 15%) / 0.05);
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
    --prism-shadow: 0 1px 2px 0 hsl(var(--shadow-color, 0 0% 0%) / 0.05);
  }
  .prism-refresh {
    flex-shrink: 0; margin-left: 16px; height: 32px; padding: 0 10px;
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--prism-bg); border: 1px solid var(--prism-input); box-shadow: var(--prism-shadow);
    color: var(--prism-text); font-family: ${SANS}; font-size: 0.8125rem; font-weight: 500;
    border-radius: ${RADIUS_MD}; cursor: pointer; transition: background-color 0.15s;
  }
  .prism-refresh svg { width: 14px; height: 14px; flex-shrink: 0; }
  .prism-refresh:hover { background: var(--prism-hover); }
  .prism-refresh:active { background: color-mix(in srgb, var(--prism-hover) 80%, transparent); }
  .prism-refresh:focus-visible { outline: none; box-shadow: 0 0 0 1px var(--prism-ring); }
  .prism-chip {
    display: inline-block; max-width: 100%; box-sizing: border-box;
    padding: 2px 6px; border-radius: ${RADIUS_MD};
    background: var(--prism-sunken); color: var(--prism-muted);
    font-family: ${MONO}; font-size: 0.7rem; line-height: 1.35;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: top;
  }
  .prism-link { color: var(--prism-link); text-decoration: none; }
  .prism-link:hover { text-decoration: underline; }
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

// The host passes the project's ID as `name`, so title the page with the
// project folder's name instead, as the host's own project chip does.
function projectLabel(project: PluginContext['project'], fallback: string): string {
  const folder = project?.path.split(/[\\/]/).filter(Boolean).pop();
  return folder || project?.name || fallback;
}

function subtitleHtml(c: ThemeColors, subtitle: string, isPath: boolean): string {
  return isPath
    ? `<div style="margin-top:6px;min-width:0"><span class="prism-chip" title="${subtitle}">${subtitle}</span></div>`
    : `<div style="font-size:0.75rem;color:${c.muted};margin-top:4px">${subtitle}</div>`;
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
      display:inline-block;min-width:30px;text-align:center;
      padding:2px 7px;border:1px solid ${color};border-radius:${RADIUS_SM};
      color:${color};font-family:${MONO};font-size:0.7rem;font-weight:600;letter-spacing:0.04em;
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
    padding: '24px',
    fontFamily: SANS,
  });
  container.appendChild(root);

  function paint(ctx: PluginContext): void {
    const c = themeColors();
    root.dataset.theme = ctx.theme === 'dark' ? 'dark' : 'light';
    root.style.background = c.bg;
    root.style.color = c.text;
  }

  function renderNotInstalled(ctx: PluginContext): void {
    const c = themeColors();
    paint(ctx);
    root.innerHTML = `
      <div class="prism-up" style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:60%;gap:16px">
        <pre style="font-family:${MONO};font-size:0.75rem;color:${c.muted};line-height:1.6;text-align:center;margin:0">$ prism
command not found</pre>
        <div style="font-size:0.72rem;font-weight:500;color:${c.muted};letter-spacing:0.08em;text-transform:uppercase">prism is not installed</div>
        <div style="
          background:${c.sunken};border:1px solid ${c.border};border-radius:${RADIUS_MD};
          padding:12px 18px;font-family:${MONO};font-size:0.78rem;color:${c.text};
        ">pip install prism-cc</div>
        <a class="prism-link" href="https://github.com/jakeefr/prism" target="_blank" rel="noreferrer" style="font-size:0.74rem">github.com/jakeefr/prism →</a>
      </div>`;
  }

  function renderError(ctx: PluginContext, message: string): void {
    const c = themeColors();
    paint(ctx);
    root.innerHTML = `
      <div style="padding:24px;font-size:0.78rem;color:${c.danger};font-family:${MONO}">
        ✗ ${esc(message)}
      </div>`;
  }

  function renderLoading(ctx: PluginContext): void {
    const c = themeColors();
    paint(ctx);
    const title = ctx.project ? esc(projectLabel(ctx.project, 'project')) : 'all projects';
    const subtitle = ctx.project ? esc(ctx.project.path) : 'session health overview';
    root.innerHTML = `
      <div style="margin-bottom:24px">
        <div style="font-family:${SERIF};font-size:1.45rem;font-weight:600">${title}</div>
        ${subtitleHtml(c, subtitle, Boolean(ctx.project))}
      </div>
      <div style="background:${c.surface};border:1px solid ${c.border};border-radius:${RADIUS_XL};box-shadow:var(--prism-shadow);padding:18px;margin-bottom:12px">
        ${skeletonRows(c, [30, 70, 55, 62, 48, 40])}
      </div>
      <div style="background:${c.surface};border:1px solid ${c.border};border-radius:${RADIUS_XL};box-shadow:var(--prism-shadow);padding:18px">
        ${skeletonRows(c, [80, 65, 50])}
      </div>`;
  }

  function header(ctx: PluginContext, c: ThemeColors, title: string, subtitle: string, isPath = true): string {
    return `
      <div class="prism-up" style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:24px">
        <div style="min-width:0;flex:1">
          <div style="font-family:${SERIF};font-size:1.45rem;font-weight:600;letter-spacing:-0.01em;word-break:break-all">
            ${title}
          </div>
          ${subtitleHtml(c, subtitle, isPath && subtitle !== '')}
        </div>
        <button id="prism-refresh" class="prism-refresh">${REFRESH_ICON}Refresh</button>
      </div>`;
  }

  function renderReport(ctx: PluginContext, report: Report): void {
    const c = themeColors();
    paint(ctx);
    const overallColor = gradeColor(report.overall_grade, c);

    root.innerHTML = `
      ${header(ctx, c, esc(projectLabel(ctx.project, report.display_name)), esc(ctx.project?.path ?? report.display_name))}

      <div class="prism-up" style="
        display:flex;align-items:center;gap:20px;
        background:${c.surface};border:1px solid ${c.border};
        border-radius:${RADIUS_XL};box-shadow:var(--prism-shadow);padding:20px;margin-bottom:12px;
      ">
        <div style="
          font-family:${SERIF};font-size:2.8rem;font-weight:600;letter-spacing:-0.02em;line-height:1;
          color:${overallColor};min-width:74px;text-align:center;
        ">${esc(report.overall_grade)}</div>
        <div style="flex:1">
          <div style="display:flex;justify-content:space-between;font-size:0.68rem;color:${c.muted};margin-bottom:8px">
            <span style="font-weight:500;letter-spacing:0.08em;text-transform:uppercase">overall health</span>
            <span style="font-family:${MONO}">${Number(report.overall_score).toFixed(1)} / 100 · ${Number(report.session_count)} session${report.session_count === 1 ? '' : 's'}${health?.version ? ` · prism v${esc(health.version)}` : ''}</span>
          </div>
          ${scoreBar(report.overall_score, report.overall_grade, c, 0.1)}
        </div>
      </div>

      <div class="prism-up" style="
        background:${c.surface};border:1px solid ${c.border};
        border-radius:${RADIUS_XL};box-shadow:var(--prism-shadow);padding:18px;margin-bottom:12px;animation-delay:0.08s
      ">
        <div style="font-size:0.64rem;font-weight:500;color:${c.muted};letter-spacing:0.1em;text-transform:uppercase;margin-bottom:14px">dimensions</div>
        ${DIMENSIONS.map(([key, label], i) => {
          const dim = report.dimensions[key];
          if (!dim) return '';
          return `
          <div class="prism-up" style="display:flex;align-items:center;gap:12px;margin-bottom:9px;animation-delay:${0.12 + i * 0.04}s">
            <div style="width:160px;font-size:0.72rem;color:${c.muted};flex-shrink:0">${label}</div>
            ${scoreBar(dim.score, dim.grade, c, 0.15 + i * 0.04)}
            <div style="width:42px;font-family:${MONO};font-size:0.68rem;color:${c.muted};text-align:right;flex-shrink:0">${Number(dim.score).toFixed(0)}</div>
            ${gradeChip(dim.grade, c)}
          </div>`;
        }).join('')}
      </div>

      <div class="prism-up" style="
        background:${c.surface};border:1px solid ${c.border};
        border-radius:${RADIUS_XL};box-shadow:var(--prism-shadow);padding:18px;animation-delay:0.16s
      ">
        <div style="font-size:0.64rem;font-weight:500;color:${c.muted};letter-spacing:0.1em;text-transform:uppercase;margin-bottom:12px">top issues</div>
        ${
          report.top_issues.length === 0
            ? `<div style="font-size:0.72rem;color:${c.muted}">none found</div>`
            : report.top_issues
                .map(
                  (issue, i) => `
            <div class="prism-up" style="
              display:flex;gap:10px;align-items:baseline;
              padding:7px 0;border-bottom:1px solid ${c.border};font-size:0.74rem;line-height:1.5;
              animation-delay:${0.2 + i * 0.04}s;
            ">
              <span style="
                flex-shrink:0;font-size:0.62rem;font-weight:600;letter-spacing:0.08em;
                text-transform:uppercase;color:${severityColor(issue.severity, c)};
              ">${esc(issue.severity)}</span>
              <span style="flex-shrink:0;font-family:${MONO};font-size:0.66rem;color:${c.muted}">${esc(issue.category)}</span>
              <span>${esc(issue.description)}</span>
            </div>`,
                )
                .join('')
        }
      </div>
    `;

    root.querySelector('#prism-refresh')?.addEventListener('click', () => {
      cache = null;
      load(api.context);
    });
  }

  function renderOverview(ctx: PluginContext, reports: Report[]): void {
    const c = themeColors();
    paint(ctx);
    const sorted = [...reports].sort((a, b) => a.overall_score - b.overall_score);

    root.innerHTML = `
      ${header(ctx, c, 'all projects', 'session health overview · select a project for the full report', false)}

      <div class="prism-up" style="
        background:${c.surface};border:1px solid ${c.border};
        border-radius:${RADIUS_XL};box-shadow:var(--prism-shadow);padding:18px;animation-delay:0.06s
      ">
        <div style="font-size:0.64rem;font-weight:500;color:${c.muted};letter-spacing:0.1em;text-transform:uppercase;margin-bottom:14px">
          ${sorted.length} project${sorted.length === 1 ? '' : 's'} · worst first
        </div>
        ${
          sorted.length === 0
            ? `<div style="font-size:0.72rem;color:${c.muted}">no projects with session data found</div>`
            : sorted
                .map(
                  (r, i) => `
          <div class="prism-up" style="display:flex;align-items:center;gap:12px;margin-bottom:9px;animation-delay:${0.1 + i * 0.03}s">
            <div style="
              flex:1;min-width:0;font-family:${MONO};font-size:0.7rem;overflow:hidden;
              text-overflow:ellipsis;white-space:nowrap;
            " title="${esc(r.display_name)}">${esc(r.display_name)}</div>
            <div style="width:70px;font-family:${MONO};font-size:0.66rem;color:${c.muted};text-align:right;flex-shrink:0">
              ${Number(r.session_count)} sess
            </div>
            <div style="width:120px;flex-shrink:0;display:flex">
              ${scoreBar(r.overall_score, r.overall_grade, c, 0.12 + i * 0.03)}
            </div>
            <div style="width:42px;font-family:${MONO};font-size:0.68rem;color:${c.muted};text-align:right;flex-shrink:0">${Number(r.overall_score).toFixed(0)}</div>
            ${gradeChip(r.overall_grade, c)}
          </div>`,
                )
                .join('')
        }
      </div>
    `;

    root.querySelector('#prism-refresh')?.addEventListener('click', () => {
      cache = null;
      load(api.context);
    });
  }

  function renderNoData(ctx: PluginContext): void {
    const c = themeColors();
    paint(ctx);
    root.innerHTML = `
      ${header(ctx, c, esc(projectLabel(ctx.project, 'project')), esc(ctx.project?.path ?? ''))}
      <div class="prism-up" style="
        background:${c.surface};border:1px solid ${c.border};
        border-radius:${RADIUS_XL};box-shadow:var(--prism-shadow);padding:28px 24px;text-align:center;animation-delay:0.06s
      ">
        <div style="font-size:0.64rem;font-weight:500;color:${c.muted};letter-spacing:0.1em;text-transform:uppercase;margin-bottom:10px">no session data</div>
        <div style="font-size:0.78rem;color:${c.text};line-height:1.7">
          PRISM has no recorded Claude Code sessions for this project yet.<br>
          Run a session here, then hit refresh.
        </div>
      </div>`;
    root.querySelector('#prism-refresh')?.addEventListener('click', () => {
      cache = null;
      load(api.context);
    });
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
