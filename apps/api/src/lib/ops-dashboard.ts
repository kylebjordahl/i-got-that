/**
 * Static shell for the `/ops` dashboard — Chart.js (CDN) reading the JSON
 * from the sibling `/ops/summary`, `/ops/timeseries`, `/ops/clients`
 * endpoints. Colors follow the project's dataviz reference palette
 * (categorical slots 1–3: blue/orange/aqua); D1-only for now, see ops.ts.
 */
export const opsDashboardHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>igt ops</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.4/chart.umd.min.js"></script>
<style>
  :root {
    color-scheme: light;
    --surface-1: #fcfcfb;
    --page: #f9f9f7;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --text-muted: #898781;
    --gridline: #e1e0d9;
    --baseline: #c3c2b7;
    --border: rgba(11,11,11,0.10);
    --series-1: #2a78d6;
    --series-2: #eb6834;
    --series-3: #1baf7a;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --surface-1: #1a1a19;
      --page: #0d0d0d;
      --text-primary: #ffffff;
      --text-secondary: #c3c2b7;
      --text-muted: #898781;
      --gridline: #2c2c2a;
      --baseline: #383835;
      --border: rgba(255,255,255,0.10);
      --series-1: #3987e5;
      --series-2: #d95926;
      --series-3: #199e70;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--page);
    color: var(--text-primary);
    font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 24px;
  }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .subtitle { color: var(--text-secondary); margin: 0 0 24px; }
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 12px;
    margin-bottom: 24px;
  }
  .stat {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 16px;
  }
  .stat .value { font-size: 26px; font-weight: 600; }
  .stat .label { color: var(--text-secondary); font-size: 12px; margin-top: 2px; }
  .stat .sub { color: var(--text-muted); font-size: 11px; margin-top: 4px; }
  .charts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
    gap: 16px;
  }
  .card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
  }
  .card h2 { font-size: 13px; font-weight: 600; margin: 0 0 12px; color: var(--text-secondary); }
  .card.wide { grid-column: 1 / -1; }
  canvas { max-height: 260px; }
  .error { color: #e34948; padding: 40px; text-align: center; }
</style>
</head>
<body>
  <h1>igt — ops dashboard</h1>
  <p class="subtitle">Platform-wide, not scoped to a family. D1 only for now.</p>
  <div id="root">
    <div class="stats" id="stats"></div>
    <div class="charts">
      <div class="card wide"><h2>Volume over time</h2><canvas id="volume"></canvas></div>
      <div class="card"><h2>Login provider</h2><canvas id="providers"></canvas></div>
      <div class="card"><h2>Calendar target</h2><canvas id="targets"></canvas></div>
      <div class="card"><h2>Tasks by status</h2><canvas id="tasks"></canvas></div>
    </div>
  </div>
<script>
(function () {
  const base = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';
  const css = getComputedStyle(document.documentElement);
  const c = (name) => css.getPropertyValue(name).trim();

  async function getJson(path) {
    const res = await fetch(base + path, { credentials: 'include' });
    if (!res.ok) throw new Error(path + ': ' + res.status);
    return res.json();
  }

  function statTile(value, label, sub) {
    const el = document.createElement('div');
    el.className = 'stat';
    el.innerHTML = '<div class="value">' + value + '</div>' +
      '<div class="label">' + label + '</div>' +
      (sub ? '<div class="sub">' + sub + '</div>' : '');
    return el;
  }

  function baseOptions(legend) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: legend, labels: { color: c('--text-secondary'), boxWidth: 10 } },
        tooltip: { mode: 'index', intersect: false },
      },
      scales: {
        x: { grid: { color: c('--gridline') }, ticks: { color: c('--text-muted') } },
        y: {
          beginAtZero: true,
          grid: { color: c('--gridline') },
          ticks: { color: c('--text-muted'), precision: 0 },
        },
      },
    };
  }

  function toSeries(rows, days) {
    const byDay = Object.fromEntries(rows.map((r) => [r.key, r.n]));
    const labels = [];
    const values = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);
      labels.push(key.slice(5));
      values.push(byDay[key] || 0);
    }
    return { labels, values };
  }

  async function render() {
    const [summary, timeseries, clients] = await Promise.all([
      getJson('summary'),
      getJson('timeseries?days=30'),
      getJson('clients'),
    ]);

    const stats = document.getElementById('stats');
    stats.append(
      statTile(summary.users, 'Users'),
      statTile(summary.families, 'Families'),
      statTile(summary.members, 'Members'),
      statTile(
        summary.feeds.active,
        'Active feeds',
        summary.feeds.error ? summary.feeds.error + ' in error' : undefined,
      ),
      statTile(summary.calendarEvents.last30d, 'Calendar events (30d)', summary.calendarEvents.last7d + ' in last 7d'),
      statTile(summary.sourceEvents.last30d, 'Source events ingested (30d)'),
    );

    const days = timeseries.days;
    const signups = toSeries(timeseries.series.signups, days);
    const calEvents = toSeries(timeseries.series.calendarEventsCreated, days);
    const srcEvents = toSeries(timeseries.series.sourceEventsIngested, days);

    new Chart(document.getElementById('volume'), {
      type: 'line',
      data: {
        labels: signups.labels,
        datasets: [
          { label: 'Signups', data: signups.values, borderColor: c('--series-1'), backgroundColor: c('--series-1'), borderWidth: 2, pointRadius: 0, tension: 0.2 },
          { label: 'Calendar events created', data: calEvents.values, borderColor: c('--series-2'), backgroundColor: c('--series-2'), borderWidth: 2, pointRadius: 0, tension: 0.2 },
          { label: 'Source events ingested', data: srcEvents.values, borderColor: c('--series-3'), backgroundColor: c('--series-3'), borderWidth: 2, pointRadius: 0, tension: 0.2 },
        ],
      },
      options: baseOptions(true),
    });

    function bar(canvasId, rows, labelFn) {
      new Chart(document.getElementById(canvasId), {
        type: 'bar',
        data: {
          labels: rows.map((r) => labelFn(r.key)),
          datasets: [{ data: rows.map((r) => r.n), backgroundColor: c('--series-1'), borderRadius: 4, maxBarThickness: 40 }],
        },
        options: baseOptions(false),
      });
    }

    const titleCase = (s) => s.replace(/_/g, ' ').replace(/\\b\\w/g, (m) => m.toUpperCase());
    bar('providers', clients.loginProviders, titleCase);
    bar('targets', clients.calendarTargets, titleCase);
    bar('tasks', summary.tasksByStatus, titleCase);
  }

  render().catch((err) => {
    document.getElementById('root').innerHTML = '<div class="error">Failed to load: ' + err.message + '</div>';
  });
})();
</script>
</body>
</html>`;
