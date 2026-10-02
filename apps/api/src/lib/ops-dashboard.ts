/**
 * Static shell for the `/ops` dashboard — Chart.js (CDN) reading the JSON
 * from the sibling `/ops/summary`, `/ops/timeseries`, `/ops/clients` (D1) and
 * `/ops/requests` (Analytics Engine) endpoints. Colors follow the project's
 * dataviz reference palette (categorical slots 1–3: blue/orange/aqua; the
 * fixed status warning/critical pair for 4xx/5xx).
 */
export const opsDashboardHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>igt ops</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.js"></script>
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
    --status-warn: #fab219;
    --status-crit: #d03b3b;
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
  h2.section { font-size: 15px; margin: 32px 0 12px; }
  .note { color: var(--text-secondary); margin: 0 0 16px; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: right; padding: 6px 10px; border-bottom: 1px solid var(--gridline); font-variant-numeric: tabular-nums; }
  th:first-child, td:first-child { text-align: left; }
  th { color: var(--text-secondary); font-weight: 600; }
</style>
</head>
<body>
  <h1>igt — ops dashboard</h1>
  <p class="subtitle">Platform-wide, not scoped to a family. State and processing volume come from D1; API traffic from Analytics Engine.</p>
  <div id="root">
    <div class="stats" id="stats"></div>
    <div class="charts">
      <div class="card wide"><h2>Volume over time</h2><canvas id="volume"></canvas></div>
      <div class="card"><h2>Login provider</h2><canvas id="providers"></canvas></div>
      <div class="card"><h2>Calendar target</h2><canvas id="targets"></canvas></div>
      <div class="card"><h2>Tasks by status</h2><canvas id="tasks"></canvas></div>
    </div>
    <h2 class="section">API traffic</h2>
    <p class="note" id="req-note">Loading…</p>
    <div id="req-body" hidden>
      <div class="stats" id="req-stats"></div>
      <div class="charts">
        <div class="card"><h2>Requests per day by client</h2><canvas id="clients-chart"></canvas></div>
        <div class="card"><h2>Errors per day</h2><canvas id="errors-chart"></canvas></div>
        <div class="card wide">
          <h2>Busiest routes</h2>
          <div class="table-wrap"><table id="routes-table"></table></div>
        </div>
      </div>
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

  function sum(rows, pick) {
    return rows.reduce((total, r) => total + (pick(r) ? r.n : 0), 0);
  }

  function fmt(n) {
    return Math.round(n).toLocaleString('en-US');
  }

  function pct(part, whole) {
    return whole ? Math.round((part / whole) * 100) + '%' : '0%';
  }

  function line(label, values, color) {
    return { label: label, data: values, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, tension: 0.2 };
  }

  async function renderRequests() {
    const note = document.getElementById('req-note');
    const res = await fetch(base + 'requests?days=30', { credentials: 'include' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      note.textContent = 'Traffic data unavailable: ' + (data.error || res.status);
      return;
    }
    if (!data.configured) {
      note.textContent = 'Request telemetry is not configured for this environment (see docs/DEPLOYMENT.md, Request telemetry).';
      return;
    }
    const total = sum(data.byClient, () => true);
    if (!total) {
      note.textContent = 'No requests recorded yet.';
      return;
    }
    note.hidden = true;
    document.getElementById('req-body').hidden = false;

    const errors5xx = sum(data.byStatus, (r) => r.cls === '5xx');
    const errors4xx = sum(data.byStatus, (r) => r.cls === '4xx');
    document.getElementById('req-stats').append(
      statTile(fmt(total), 'Requests (' + data.days + 'd)'),
      statTile(pct(sum(data.byClient, (r) => r.client === 'web'), total), 'Web share', 'native ' + pct(sum(data.byClient, (r) => r.client === 'native'), total) + ' · other ' + pct(sum(data.byClient, (r) => r.client === 'other'), total)),
      statTile(fmt(errors5xx), 'Server errors (5xx)', pct(errors5xx, total) + ' of requests'),
      statTile(fmt(errors4xx), 'Client errors (4xx)', pct(errors4xx, total) + ' of requests'),
    );

    const days = data.days;
    const byClient = (kind) => toSeries(data.byClient.filter((r) => r.client === kind).map((r) => ({ key: r.day, n: r.n })), days);
    const byClass = (cls) => toSeries(data.byStatus.filter((r) => r.cls === cls).map((r) => ({ key: r.day, n: r.n })), days);
    const web = byClient('web');

    new Chart(document.getElementById('clients-chart'), {
      type: 'line',
      data: {
        labels: web.labels,
        datasets: [
          line('Web', web.values, c('--series-1')),
          line('Native app', byClient('native').values, c('--series-2')),
          line('Other', byClient('other').values, c('--series-3')),
        ],
      },
      options: baseOptions(true),
    });

    new Chart(document.getElementById('errors-chart'), {
      type: 'line',
      data: {
        labels: web.labels,
        datasets: [
          line('Client errors (4xx)', byClass('4xx').values, c('--status-warn')),
          line('Server errors (5xx)', byClass('5xx').values, c('--status-crit')),
        ],
      },
      options: baseOptions(true),
    });

    const table = document.getElementById('routes-table');
    const head = table.createTHead().insertRow();
    ['Route', 'Requests', '4xx', '5xx', 'p95 ms'].forEach((label) => {
      const th = document.createElement('th');
      th.textContent = label;
      head.appendChild(th);
    });
    const body = table.createTBody();
    data.routes.forEach((r) => {
      const row = body.insertRow();
      [r.route, fmt(r.n), fmt(r.e4xx), fmt(r.e5xx), fmt(r.p95Ms)].forEach((value) => {
        row.insertCell().textContent = value;
      });
    });
  }

  renderRequests().catch((err) => {
    document.getElementById('req-note').textContent = 'Traffic data unavailable: ' + err.message;
  });

  render().catch((err) => {
    document.getElementById('root').innerHTML = '<div class="error">Failed to load: ' + err.message + '</div>';
  });
})();
</script>
</body>
</html>`;
