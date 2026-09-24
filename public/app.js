const $ = id => document.getElementById(id);
let state = { sites: [], interval: 60 }, editing = null, rendered = '', removing = null;
const form = $('site-form');
const selectedBars = new Map();
async function api(path, method = 'GET', data) {
  const response = await fetch('/api/' + path, { method, headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Something went wrong. Please try again.');
  return result;
}
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
function openEditor(s) {
  editing = s?.id || null; form.reset(); $('form-error').textContent = '';
  $('dialog-title').textContent = s ? 'Edit website' : 'Add website';
  if (s) for (const key of ['name', 'url', 'loginUrl', 'healthUrl', 'expected']) form.elements[key].value = s[key];
  $('editor').showModal(); form.elements.name.focus();
}
function card(s) {
  const c = el('article', 'card'), top = el('div', 'card-top'), heading = el('div', 'site-heading');
  heading.append(el('h3', '', s.name), el('div', 'domain', new URL(s.url).host));
  const edit = el('button', 'edit', 'Edit'); edit.setAttribute('aria-label', `Edit ${s.name}`); edit.onclick = () => openEditor(s);
  top.append(el('div', 'site-icon', s.name.slice(0, 2).toUpperCase()), heading, edit);
  const line = el('div', 'status-line'), badge = el('span', 'badge ' + s.status.state);
  badge.append(el('i', 'dot ' + s.status.state), document.createTextNode({ up: 'Online', down: 'Offline', unknown: 'Not checked' }[s.status.state]));
  line.append(badge, el('span', 'response', s.status.latency === null ? '—' : `${s.status.latency} ms`));
  const checked = s.status.checkedAt ? new Date(s.status.checkedAt).toLocaleString() : 'Not yet';
  const actions = el('div', 'card-actions');
  for (const [label, url, cls] of [['Open ↗', s.url, ''], ['Sign in ↗', s.loginUrl || s.url, 'login']]) { const a = el('a', cls, label); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.setAttribute('aria-label', `${label.replace(' ↗', '')} ${s.name}`); actions.append(a); }
  const remove = el('button', 'remove', 'Remove'); remove.setAttribute('aria-label', `Remove ${s.name}`);
  remove.onclick = () => { removing = s.id; $('remove-description').textContent = `Remove “${s.name}” from your directory?`; $('remove-error').textContent = ''; $('removal').showModal(); $('keep-site').focus(); };
  const timeline = el('div', 'timeline');
  const historyHead = el('div', 'history-head');
  const percent = s.timeline?.uptime == null ? '—' : s.timeline.uptime.toFixed(2) + '%';
  const percentState = !s.timeline?.checks ? 'unknown' : s.timeline.failed ? s.timeline.uptime === 0 ? 'down' : 'mixed' : 'up';
  const pill = el('strong', 'uptime-pill ' + percentState, percent); pill.title = 'Percentage of recorded checks that passed in the last two hours';
  historyHead.append(pill, el('span', '', 'Last 2 hours'));
  const bars = el('div', 'history-bars'); bars.setAttribute('aria-label', 'Five-minute status periods, oldest to newest');
  for (const bin of s.timeline?.bins || []) {
    const bar = el('button', 'history-bar ' + bin.state);
    const label = `${new Date(bin.from).toLocaleTimeString()}–${new Date(bin.to).toLocaleTimeString()}: ${bin.up} passed, ${bin.down} failed${bin.state === 'unknown' ? ', no data' : ''}`;
    bar.title = label; bar.setAttribute('aria-label', label); bar.dataset.focusKey = s.id + ':' + bars.childElementCount; bar.onclick = () => { selectedBars.set(s.id, label); note.textContent = label; };
    bars.append(bar);
  }
  const note = el('p', 'timeline-note', s.timeline?.checks ? `${s.timeline.failed} failed / ${s.timeline.checks} checks · Tap a bar for details` : 'No checks yet · Gray means no data');
  if (selectedBars.has(s.id)) note.textContent = selectedBars.get(s.id);
  const view = el('button', 'history-link', 'View saved history'); view.setAttribute('aria-label', `View history for ${s.name}`); view.onclick = () => openHistory(s);
  timeline.append(historyHead, bars, note, view);
  c.append(top, line, el('div', 'detail', s.status.detail), timeline, el('div', 'checked', 'Last checked · ' + checked), actions, remove); return c;
}
function render() {
  const signature = JSON.stringify(state);
  if (signature === rendered) return;
  rendered = signature;
  $('total').textContent = $('count').textContent = state.sites.length;
  $('online').textContent = state.sites.filter(s => s.status.state === 'up').length;
  $('offline').textContent = state.sites.filter(s => s.status.state === 'down').length;
  const times = state.sites.map(s => s.status.latency).filter(n => n !== null);
  $('latency').textContent = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) + ' ms' : '—';
  if (![...$('interval').options].some(o => +o.value === state.interval)) $('interval').add(new Option(state.interval + ' seconds', state.interval));
  $('interval').value = state.interval;
  $('empty').hidden = state.sites.length > 0;
  $('refresh').disabled = state.checking; $('refresh').textContent = state.checking ? 'Checking…' : '↻ Check now';
  const active = document.activeElement, label = active?.getAttribute('aria-label'), focusKey = active?.dataset.focusKey;
  const restore = $('sites').contains(active);
  $('sites').replaceChildren(...state.sites.map(card));
  if (restore && label) [...$('sites').querySelectorAll('[aria-label]')].find(e => focusKey ? e.dataset.focusKey === focusKey : e.getAttribute('aria-label') === label)?.focus();
}
async function load() { try { state = await api('state'); render(); $('message').textContent = ''; const notice = [state.monitoringError, state.alerts?.failed ? `${state.alerts.failed} email notification(s) could not be delivered. Check History & alerts.` : '', state.alerts?.pending ? `${state.alerts.pending} email notification(s) awaiting delivery.` : ''].filter(Boolean).join(' '); $('system-notice').textContent = notice; $('system-notice').hidden = !notice; } catch { $('message').textContent = 'Cannot reach Harbor. Displayed status may be out of date. Retrying…'; } }
$('add').onclick = $('first').onclick = () => openEditor();
$('close').onclick = $('cancel').onclick = () => $('editor').close();
$('keep-site').onclick = () => $('removal').close();
$('confirm-remove').onclick = async () => { $('confirm-remove').disabled = true; try { await api('sites/' + removing, 'DELETE', {}); $('removal').close(); await load(); } catch (e) { $('remove-error').textContent = e.message; } finally { $('confirm-remove').disabled = false; } };
form.onsubmit = async event => { event.preventDefault(); const button = form.querySelector('[type=submit]'); button.disabled = true; try { const data = Object.fromEntries(new FormData(form)); await api(editing ? 'sites/' + editing : 'sites', editing ? 'PUT' : 'POST', data); $('editor').close(); await load(); } catch (e) { $('form-error').textContent = e.message; } finally { button.disabled = false; } };
$('interval').onchange = async () => { try { await api('settings', 'PUT', { interval: +$('interval').value }); await load(); } catch (e) { $('interval').value = state.interval; $('message').textContent = e.message; } };
$('refresh').onclick = async () => { try { await api('check', 'POST', {}); await load(); } catch (e) { $('message').textContent = e.message; } };
async function poll() { await load(); setTimeout(poll, 2000); } void poll();
const smtpForm = $('smtp-form');
let historySite = null;
function populateSmtp(smtp) {
  for (const name of ['host', 'port', 'security', 'username', 'from', 'to', 'failures']) smtpForm.elements[name].value = smtp[name];
  for (const name of ['enabled', 'recovery']) smtpForm.elements[name].checked = smtp[name];
  smtpForm.elements.password.value = ''; smtpForm.elements.clearPassword.checked = false;
  $('password-status').textContent = smtp.hasPassword ? 'A password is saved. Leave blank to keep it.' : 'No password saved. Leave username and password blank for an unauthenticated relay.';
  $('smtp-test').disabled = !smtp.host || !smtp.from || !smtp.to;
}
$('settings').onclick = async () => {
  try { const smtp = await api('smtp'); populateSmtp(smtp); $('retention-form').elements.retentionDays.value = state.retentionDays; $('retention-message').textContent = ''; $('smtp-message').textContent = ''; const delivery = state.alerts?.latest; $('delivery-status').textContent = delivery ? `Latest alert: ${delivery.status}${delivery.error ? ' · ' + delivery.error : ''}` : 'No alert deliveries yet.'; $('settings-dialog').showModal(); } catch (e) { $('message').textContent = e.message; }
};
$('settings-close').onclick = () => { $('settings-dialog').close(); smtpForm.elements.password.value = ''; };
$('settings-dialog').addEventListener('close', () => { smtpForm.elements.password.value = ''; });
$('retention-form').onsubmit = async event => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
  try { await api('settings', 'PUT', { retentionDays: +event.target.elements.retentionDays.value }); await load(); $('retention-message').textContent = `Saved. History will be kept for ${state.retentionDays} days.`; } catch (e) { $('retention-message').textContent = e.message; } finally { button.disabled = false; }
};
smtpForm.addEventListener('input', () => { $('smtp-test').disabled = true; $('smtp-message').textContent = 'Save these settings before sending a test email.'; });
smtpForm.onsubmit = async event => {
  event.preventDefault(); const button = smtpForm.querySelector('[type=submit]'); button.disabled = true;
  const data = Object.fromEntries(new FormData(smtpForm));
  for (const field of ['enabled', 'recovery', 'clearPassword']) data[field] = smtpForm.elements[field].checked;
  for (const field of ['port', 'failures']) data[field] = +data[field];
  try { const saved = await api('smtp', 'PUT', data); populateSmtp(saved); $('smtp-message').textContent = 'Relay settings saved. You can now send a test email.'; await load(); } catch (e) { $('smtp-message').textContent = e.message; } finally { smtpForm.elements.password.value = ''; button.disabled = false; }
};
$('smtp-test').onclick = async () => { $('smtp-test').disabled = true; $('smtp-message').textContent = 'Sending test email…'; try { const result = await api('smtp/test', 'POST', {}); $('smtp-message').textContent = result.message; } catch (e) { $('smtp-message').textContent = e.message; } finally { $('smtp-test').disabled = false; } };
function table(headers, rows) { const t = el('table'), head = el('thead'), header = el('tr'), body = el('tbody'); for (const name of headers) { const cell = el('th', '', name); cell.scope = 'col'; header.append(cell); } head.append(header); for (const row of rows) { const tr = el('tr'); for (const value of row) tr.append(el('td', '', String(value))); body.append(tr); } t.append(head, body); return t; }
async function showHistory() {
  $('history-summary').textContent = 'Loading history…'; $('history-days').replaceChildren(); $('history-failures').replaceChildren();
  const id = historySite.id, days = +$('history-range').elements.days.value;
  try { const data = await api(`history/${id}?days=${days}`); if (historySite.id !== id) return; $('history-summary').textContent = data.checks ? `${data.uptime.toFixed(2)}% checks passed · ${data.failed} failed of ${data.checks} recorded checks` : 'No history recorded in this period yet.';
    $('history-days').append(table(['Date (UTC)', 'Checks passed', 'Failed', 'Avg response'], data.daily.map(d => [new Date(d.at).toISOString().slice(0, 10), (100 * d.up / (d.up + d.down)).toFixed(2) + '%', d.down, d.latencyCount ? Math.round(d.latencySum / d.latencyCount) + ' ms' : '—'])));
    $('history-failures').append(data.failures.length ? table(['Period start', 'Passed', 'Failed'], data.failures.map(d => [new Date(d.at).toLocaleString(), d.up, d.down])) : el('p', 'hint', 'No failed checks recorded in this period.'));
  } catch (e) { $('history-summary').textContent = e.message; }
}
function openHistory(s) { historySite = s; $('history-title').textContent = s.name + ' · history'; $('history-range').elements.days.max = state.retentionDays; $('history-range').elements.days.value = state.retentionDays; $('history-dialog').showModal(); void showHistory(); }
$('history-range').onsubmit = event => { event.preventDefault(); void showHistory(); };
$('history-close').onclick = () => $('history-dialog').close();
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  try { Promise.resolve(document.modelContext.registerTool({ name: 'read_website_statuses', description: 'Read the configured websites and current health results shown in Harbor.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: async input => { if (!input || Object.keys(input).length) throw new Error('Expected an empty object.'); state = await api('state'); render(); return state; } }, { signal: lifecycle.signal })).catch(() => {}); } catch {}
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
}
