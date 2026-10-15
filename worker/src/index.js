// CampSwoop API at api.campswoop.com (Cloudflare Workers).
//
// The sign-up page posts here; this Worker stores the watch in D1 (binding DB), emails a confirm link,
// and serves the confirm, stop and manage pages. The checker (alerts.py on GitHub Actions) calls the
// /api/ endpoints with API_TOKEN to list active watches and to email a watcher. Only this Worker sees
// email addresses; it sends all email through Resend (RESEND_API_KEY).

const MAX_WATCHES_PER_PERSON = 3;
const MAX_ACTIVE_WATCHES = 50;
const MAX_NIGHTS = 14;
const MAX_DAYS_AHEAD = 400;
const MAX_SIGNUPS_PER_IP_PER_HOUR = 10;
const MAX_SIGNUPS_PER_EMAIL_PER_DAY = 6;
const DAILY_EMAIL_LIMIT = 90; // Resend's free plan stops at 100 a day
const UNCONFIRMED_DAYS = 7; // sign-ups never confirmed are dropped after this

// Booking links CampSwoop can watch. Keep in sync with SOURCES in alerts.py and docs/index.html.
const SOURCES = [
  { key: "recgov", title: "Recreation.gov", pattern: /recreation\.gov\/camping\/(campgrounds|campsites)\/(\d+)/i },
  { key: "firefly", title: "Firefly Reservations", pattern: /fireflyreservations\.com\/reserve\/property\/([A-Za-z0-9_-]+)/i },
  { key: "camis", title: "GoingToCamp",
    pattern: /https?:\/\/(?:[\w-]+\.)*(?:goingtocamp\.com|pc\.gc\.ca|bcparks\.ca|ontarioparks\.ca)\/\S*?[?&]resourceLocationId=-?\d+/i },
];
const CAMPING = { any: "any site", tent: "a tent", trailer: "a trailer", motorhome: "a motorhome or van", rv: "an RV" };
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

class NotFound extends Error {}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;
    try {
      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: { ...corsHeaders(request, env),
          "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" } });
      }
      if (pathname === "/signup" && method === "POST") return withCors(await signup(request, env), request, env);
      if (pathname === "/requested" && method === "POST") return withCors(await requested(request, env), request, env);
      if (pathname === "/confirm" && method === "GET") return confirm(url, env);
      if (pathname === "/stop" && (method === "GET" || method === "POST")) return stop(request, url, env);
      if (pathname === "/unsubscribe" && method === "POST") return unsubscribe(url, env);
      if (pathname === "/manage" && method === "GET") return manage(url, env);
      if (pathname.startsWith("/api/")) {
        if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
        if (pathname === "/api/watches" && method === "GET") return activeWatches(env);
        if (pathname === "/api/notify" && method === "POST") return notify(request, env);
        if (pathname === "/api/end" && method === "POST") return end(request, env);
      }
      if (pathname === "/") return Response.redirect(env.SITE, 302);
      return json({ error: "not found" }, 404);
    } catch (error) {
      console.log(error && error.stack || String(error));
      return withCors(json({ error: "Something went wrong on our side. Try again in a minute." }, 500), request, env);
    }
  },
};

// --- Sign-up -----------------------------------------------------------------

async function signup(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Something went wrong. Reload the page and try again." }, 400);
  }
  if (body.website) return json({ ok: true, message: "Check your inbox." }); // a form field only bots fill in

  const email = String(body.email || "").trim().toLowerCase();
  if (email.length > 200 || !/^[^\s@<>()",;:\\[\]]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)) {
    return json({ error: "That email address doesn't look right." }, 400);
  }
  const link = String(body.link || "").trim().slice(0, 600);
  const source = SOURCES.find(s => s.pattern.test(link));
  if (!source) return json({ error: "We can't watch that booking site yet." }, 400);

  const checkIn = String(body.check_in || ""), checkOut = String(body.check_out || "");
  const start = parseDay(checkIn), finish = parseDay(checkOut), today = parseDay(todayEastern());
  if (!start || !finish) return json({ error: "Pick your check-in and check-out dates." }, 400);
  const nights = daysBetween(start, finish);
  if (start < today) return json({ error: "Your check-in date has already passed." }, 400);
  if (nights < 1) return json({ error: "Check-out must be after check-in." }, 400);
  if (nights > MAX_NIGHTS) return json({ error: `Stays can be up to ${MAX_NIGHTS} nights.` }, 400);
  if (daysBetween(today, start) > MAX_DAYS_AHEAD) return json({ error: "We can watch dates up to about a year ahead." }, 400);

  // Camis sites don't say which sites fit a tent or RV, so those watches cover any site.
  let camping = Object.hasOwn(CAMPING, body.camping) && source.key !== "camis" ? body.camping : "any";
  const length = ["trailer", "motorhome", "rv"].includes(camping) ? clamp(parseInt(body.length, 10) || 0, 0, 60) : 0;
  let name = String(body.name || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 120) || `${source.title} campground`;
  try {
    const found = await lookUp(source.key, link, camping);
    if (found) name = found;
  } catch (error) {
    if (error instanceof NotFound) return json({ error: error.message || "We couldn't find that campground. Check the link and try again." }, 400);
    console.log(`Looking up ${source.key} failed: ${error}`); // keep the name the page sent
  }

  const ip = (await sha256(`${request.headers.get("CF-Connecting-IP") || ""}|${env.API_TOKEN}`)).slice(0, 24);
  const now = new Date().toISOString();
  const ago = ms => new Date(Date.now() - ms).toISOString();
  const { results: mine } = await env.DB.prepare(
    "SELECT * FROM watches WHERE email = ? AND status IN ('pending', 'active')").bind(email).all();
  const same = mine.find(w => w.link === link && w.check_in === checkIn && w.check_out === checkOut
                           && w.camping === camping && w.length === length);
  if (same && same.status === "active") {
    return json({ ok: true, message: `You're already watching ${same.name} for those dates.` });
  }
  const [byIp, byEmail, active] = (await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n FROM watches WHERE ip = ? AND created > ?").bind(ip, ago(3600e3)),
    env.DB.prepare("SELECT COUNT(*) AS n FROM watches WHERE email = ? AND created > ?").bind(email, ago(86400e3)),
    env.DB.prepare("SELECT COUNT(*) AS n FROM watches WHERE status = 'active'"),
  ])).map(result => result.results[0].n);
  if (byIp >= MAX_SIGNUPS_PER_IP_PER_HOUR || byEmail >= MAX_SIGNUPS_PER_EMAIL_PER_DAY) {
    return json({ error: "That's a lot of sign-ups in a short time. Try again later." }, 429);
  }
  if (!same && mine.length >= MAX_WATCHES_PER_PERSON) {
    return json({ error: `You can watch up to ${MAX_WATCHES_PER_PERSON} stays at a time. Stop one first with the link in any CampSwoop email.` }, 400);
  }
  if (active >= MAX_ACTIVE_WATCHES) return json({ error: "CampSwoop is full right now. Please try again in a few days." }, 503);

  let watch = same;
  const lastSent = same && same.updated;
  if (watch) {
    // Same pending sign-up again: resend the confirm email, but not more than every 10 minutes.
    if (watch.updated > ago(600e3)) return json({ ok: true, message: `We just sent a confirm link to ${email}. Check your inbox and spam folder.` });
    await env.DB.prepare("UPDATE watches SET updated = ? WHERE id = ?").bind(now, watch.id).run();
  } else {
    watch = { id: randomId(9), token: randomId(24), email, link, name, check_in: checkIn, check_out: checkOut,
              camping, length, status: "pending", created: now, updated: now, ip };
    await env.DB.prepare(
      "INSERT INTO watches (id, token, email, link, name, check_in, check_out, camping, length, status, created, updated, ip) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(watch.id, watch.token, email, link, name, checkIn, checkOut, camping, length, "pending", now, now, ip).run();
  }
  const sent = await sendEmail(env, email, confirmationEmail(env, watch));
  if (!sent.ok) {
    // Don't let a failed send count as sent: drop a new sign-up, or let a repeat one try again right away.
    await (lastSent
      ? env.DB.prepare("UPDATE watches SET updated = ? WHERE id = ?").bind(lastSent, watch.id)
      : env.DB.prepare("DELETE FROM watches WHERE id = ?").bind(watch.id)).run();
    return json({ error: sent.error }, 503);
  }
  return json({ ok: true, message: `Almost done: we emailed a confirm link to ${email}. Tap it to start your alerts.` });
}

// Counts links people paste from booking sites CampSwoop doesn't support yet, to decide what to add next.
async function requested(request, env) {
  let host = "";
  try {
    host = String((await request.json()).host || "").toLowerCase().replace(/^www\./, "");
  } catch { /* ignore */ }
  if (/^[a-z0-9.-]{3,100}$/.test(host)) {
    await env.DB.prepare("INSERT INTO requested_sites (host, count) VALUES (?, 1) ON CONFLICT(host) DO UPDATE SET count = count + 1")
      .bind(host).run();
  }
  return json({ ok: true });
}

// The campground's real name, where that's one quick request; throws NotFound for a bad link.
async function lookUp(source, link, camping) {
  const get = url => fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(8000) });
  if (source === "recgov") {
    let [, kind, id] = link.match(SOURCES[0].pattern);
    if (kind.toLowerCase() === "campsites") {
      const site = await get(`https://www.recreation.gov/api/camps/campsites/${id}`);
      if (site.status === 404) throw new NotFound();
      if (!site.ok) return null;
      id = (await site.json()).campsite.facility_id;
    }
    const response = await get(`https://www.recreation.gov/api/camps/campgrounds/${id}`);
    if (response.status === 404) throw new NotFound();
    if (!response.ok) return null;
    const campground = (await response.json()).campground;
    const states = [...new Set((campground.addresses || []).map(a => a.state_code).filter(Boolean))];
    return campground.facility_name + (states.length === 1 ? `, ${states[0]}` : "");
  }
  if (source === "firefly") {
    const slug = link.match(SOURCES[1].pattern)[1];
    const response = await get(`https://app.fireflyreservations.com/reserve/property/${slug}`);
    if (!response.ok) return null;
    const page = await response.text();
    if (!/name="PropertyGUID" value="[0-9a-fA-F-]{36}"/.test(page)) throw new NotFound();
    const units = [...((page.match(/<select name="UnitType"[^>]*>([\s\S]*?)<\/select>/) || [])[1] || "")
      .matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
    if (camping === "tent" && units.length && !units.some(unit => /tent/i.test(unit))) {
      throw new NotFound("That campground doesn't take tent bookings online. Choose \"Any site\" instead.");
    }
    const title = page.match(/<title>\s*Reserve \|\s*([^<]+?)\s*<\/title>/);
    return title ? decodeEntities(title[1]) : null;
  }
  return null;
}

// --- Links in emails -----------------------------------------------------------

async function confirm(url, env) {
  const watch = await findWatch(env, url.searchParams);
  if (!watch) return notFoundPage(env);
  if (watch.status === "pending") {
    const active = await env.DB.prepare("SELECT COUNT(*) AS n FROM watches WHERE status = 'active'").first("n");
    if (active >= MAX_ACTIVE_WATCHES) return page(env, "CampSwoop is full", "<p>Sorry, CampSwoop is watching as many campgrounds as it can right now. Please sign up again in a few days.</p>");
    await env.DB.prepare("UPDATE watches SET status = 'active', updated = ? WHERE id = ?").bind(new Date().toISOString(), watch.id).run();
  } else if (watch.status !== "active") {
    return page(env, "This alert has ended", `<p>Alerts for ${esc(watch.name)}, ${esc(describeStay(watch))} have ended.</p>${againLink(env)}`);
  }
  return page(env, "You're all set", `
    <p>We'll email you the moment a site opens at <b>${esc(watch.name)}</b> for every night of your stay:
    ${esc(describeStay(watch))}.</p>
    <p>If a site is open right now, you'll hear from us within about 5 minutes. Sites go fast, so keep an eye on your email.</p>
    ${againLink(env, "Watch another campground")}`);
}

async function stop(request, url, env) {
  const params = request.method === "POST" ? new URLSearchParams(await request.text()) : url.searchParams;
  const watch = await findWatch(env, params);
  if (!watch) return notFoundPage(env);
  const what = `${esc(watch.name)}, ${esc(describeStay(watch))}`;
  if (watch.status !== "active" && watch.status !== "pending") {
    return page(env, "Already stopped", `<p>You're not getting alerts for ${what}.</p>${againLink(env)}`);
  }
  if (request.method === "GET") {
    // A button rather than stopping on the visit itself, so email link scanners can't stop alerts.
    return page(env, "Stop this alert?", `<p>${what}</p>${stopForm(watch, "Stop these alerts")}`);
  }
  await setStatus(env, watch.id, "stopped");
  return page(env, "Stopped", `<p>You won't get more alerts for ${what}.</p>${againLink(env, "Watch another campground")}`);
}

// One-click unsubscribe from the email app's own button (RFC 8058).
async function unsubscribe(url, env) {
  const watch = await findWatch(env, url.searchParams);
  if (watch && (watch.status === "active" || watch.status === "pending")) await setStatus(env, watch.id, "stopped");
  return new Response("Unsubscribed", { status: 200 });
}

async function manage(url, env) {
  const watch = await findWatch(env, url.searchParams);
  if (!watch) return notFoundPage(env);
  const { results } = await env.DB.prepare(
    "SELECT * FROM watches WHERE email = ? AND status IN ('pending', 'active') ORDER BY check_in").bind(watch.email).all();
  const items = results.map(w => `<li><b>${esc(w.name)}</b><br>${esc(describeStay(w))} · ${esc(rig(w))}
    ${w.status === "pending" ? "<br><i>Waiting for you to confirm</i>" : ""}${stopForm(w, "Stop")}</li>`).join("");
  return page(env, "Your alerts", `<p>${esc(watch.email)}</p>${items ? `<ul class="list">${items}</ul>` : "<p>No active alerts.</p>"}
    ${againLink(env, "Watch another campground")}`);
}

// --- API for the checker -------------------------------------------------------

async function activeWatches(env) {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - UNCONFIRMED_DAYS * 86400e3).toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE watches SET status = 'ended', updated = ? WHERE status IN ('pending', 'active') AND check_in < ?")
      .bind(now, todayEastern()),
    env.DB.prepare("UPDATE watches SET status = 'ended', updated = ? WHERE status = 'pending' AND created < ?").bind(now, cutoff),
  ]);
  const { results } = await env.DB.prepare(
    "SELECT id, link, name, check_in, check_out, camping, length FROM watches WHERE status = 'active' ORDER BY created").all();
  const counts = await env.DB.prepare(
    "SELECT COUNT(DISTINCT CASE WHEN status = 'active' THEN email END) AS people, " +
    "SUM(status = 'pending') AS pending FROM watches WHERE status IN ('active', 'pending')").first();
  const sent = await env.DB.prepare("SELECT count FROM sends WHERE day = ?").bind(todayEastern()).first("count");
  return json({ watches: results, people: counts.people || 0, pending: counts.pending || 0, emails_today: sent || 0 });
}

async function notify(request, env) {
  const body = await request.json();
  const watch = await env.DB.prepare("SELECT * FROM watches WHERE id = ? AND status = 'active'").bind(String(body.id)).first();
  if (!watch) return json({ error: "no active watch with that id" }, 404);
  const message = checkedMessage(body);
  if (!message) return json({ error: "subject, text and html are required" }, 400);
  const result = await sendEmail(env, watch.email, withFooter(env, watch, message), unsubscribeHeaders(env, watch));
  return result.ok ? json({ ok: true }) : json({ error: result.error }, result.limited ? 429 : 502);
}

async function end(request, env) {
  const body = await request.json();
  const watch = await env.DB.prepare("SELECT * FROM watches WHERE id = ? AND status IN ('pending', 'active')")
    .bind(String(body.id)).first();
  if (!watch) return json({ error: "no active watch with that id" }, 404);
  await setStatus(env, watch.id, "ended");
  const message = checkedMessage(body);
  if (message) {
    await sendEmail(env, watch.email, { subject: message.subject, text: `${message.text.trimEnd()}\n\n--\nCampSwoop · campswoop.com\n`, html: message.html });
  }
  return json({ ok: true });
}

function checkedMessage(body) {
  const { subject, text, html } = body;
  if ([subject, text, html].some(part => typeof part !== "string" || !part) || subject.length > 200 || text.length > 20000 || html.length > 60000) return null;
  return { subject, text, html };
}

// --- Email -----------------------------------------------------------------------

async function sendEmail(env, to, { subject, text, html }, headers = {}) {
  const count = await env.DB.prepare(
    "INSERT INTO sends (day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1 RETURNING count")
    .bind(todayEastern()).first("count");
  if (count > DAILY_EMAIL_LIMIT) {
    console.log(`Daily email limit reached (${DAILY_EMAIL_LIMIT})`);
    return { ok: false, limited: true, error: "CampSwoop has sent all the email it can today. Please try again tomorrow." };
  }
  if (env.RESEND_API_KEY === "log") { // local testing (.dev.vars): print instead of sending
    console.log(`EMAIL to ${to}\nSubject: ${subject}\nHeaders: ${JSON.stringify(headers)}\n${text}`);
    return { ok: true };
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", "User-Agent": "CampSwoop/1.0" },
    body: JSON.stringify({ from: env.FROM, to: [to], reply_to: env.REPLY_TO, subject, text, html, headers }),
  });
  if (!response.ok) {
    console.log(`Resend refused an email: ${response.status} ${await response.text()}`);
    return { ok: false, error: "We couldn't send email just now. Please try again in a few minutes." };
  }
  return { ok: true };
}

function confirmationEmail(env, watch) {
  const url = `${env.API_URL}/confirm?w=${watch.id}&t=${watch.token}`;
  const stay = describeStay(watch);
  const subject = `Confirm your CampSwoop alert: ${watch.name}, ${shortDates(watch)}`;
  const text = [
    "Tap this link to confirm and start your alerts:", url, "",
    `Campground: ${watch.name}`, `Stay: ${stay}`, `Camping in: ${rig(watch)}`, "",
    "Once you confirm, CampSwoop checks every 5 minutes and emails you as soon as a site is free for every night of your stay.", "",
    "Didn't sign up? Ignore this email and you won't hear from us again.", "", "CampSwoop · campswoop.com",
  ].join("\n");
  const html = emailHtml([
    para("Tap to confirm and start your alerts for:"),
    `<p style="margin:0 0 4px;font-family:${EMAIL_FONT};font-size:22px;line-height:1.25;font-weight:700;color:#f4efe6">${esc(watch.name)}</p>`,
    para(`${esc(stay)}<br>Camping in: ${esc(rig(watch))}`),
    button(url, "Confirm my alert"),
    para("Once you confirm, CampSwoop checks every 5 minutes and emails you as soon as a site is free for every night of your stay."),
    small("Didn't sign up? Ignore this email and you won't hear from us again."),
  ], `Confirm your alert for ${watch.name}, ${shortDates(watch)}.`);
  return { subject, text, html };
}

function withFooter(env, watch, { subject, text, html }) {
  const stopUrl = `${env.API_URL}/stop?w=${watch.id}&t=${watch.token}`;
  const manageUrl = `${env.API_URL}/manage?w=${watch.id}&t=${watch.token}`;
  return {
    subject,
    text: `${text.trimEnd()}\n\n--\nStop these alerts: ${stopUrl}\nAll your alerts: ${manageUrl}\nCampSwoop · campswoop.com\n`,
    html: html + emailFooter(`${emailLink(stopUrl, "Stop these alerts", "#bdb4a8")} · ${emailLink(manageUrl, "All your alerts", "#bdb4a8")} · CampSwoop`),
  };
}

function unsubscribeHeaders(env, watch) {
  return { "List-Unsubscribe": `<${env.API_URL}/unsubscribe?w=${watch.id}&t=${watch.token}>`,
           "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

// A dark card in the site's colours, the same pieces alerts.py uses for alerts. Tables and inline styles only,
// because email apps drop most CSS.
const EMAIL_FONT = "'Helvetica Neue',Helvetica,Arial,sans-serif";

function emailHtml(parts, preheader = "") {
  const hidden = preheader ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${esc(preheader)}</div>` : "";
  return `${hidden}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0b0a09" style="background:#0b0a09">` +
    `<tr><td align="center" style="padding:24px 12px 8px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#141210" style="max-width:560px;background:#141210;border:1px solid #2e2a26">` +
    `<tr><td style="padding:28px 26px 12px;font-family:${EMAIL_FONT};font-size:16px;line-height:1.55;color:#f4efe6">` +
    `<p style="margin:0 0 22px;font-family:${EMAIL_FONT};font-size:12px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#ff6a3d">CampSwoop</p>` +
    `${parts.join("")}</td></tr></table></td></tr></table>`;
}

// The stop and manage links under every alert, on the same dark ground as the card above them.
function emailFooter(htmlText) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0b0a09" style="background:#0b0a09">` +
    `<tr><td align="center" style="padding:6px 12px 28px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">` +
    `<tr><td style="padding:0 2px;font-family:${EMAIL_FONT};font-size:13px;line-height:1.5;color:#8f877c">${htmlText}</td></tr>` +
    `</table></td></tr></table>`;
}

function para(htmlText, style = "") {
  return `<p style="margin:0 0 16px;font-family:${EMAIL_FONT};font-size:16px;line-height:1.55;color:#bdb4a8;${style}">${htmlText}</p>`;
}

function emailLink(url, label, color = "#f4efe6") {
  return `<a href="${esc(url)}" style="color:${color};text-decoration:underline">${esc(label)}</a>`;
}

function button(url, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 22px"><tr>` +
    `<td bgcolor="#ff4a1c" style="background:#ff4a1c;border-radius:2px">` +
    `<a href="${esc(url)}" style="display:inline-block;padding:15px 26px;font-family:${EMAIL_FONT};font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#170a05;text-decoration:none">${esc(label)}</a>` +
    `</td></tr></table>`;
}

function small(htmlText) {
  return `<p style="margin:0 0 16px;font-family:${EMAIL_FONT};font-size:13px;line-height:1.5;color:#8f877c">${htmlText}</p>`;
}

// --- Pages -----------------------------------------------------------------------

// The confirm, stop and manage pages wear the site's look: warm black, one ember accent, wide Archivo.
function page(env, title, body, status = 200) {
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)} · CampSwoop</title>
<meta name="theme-color" content="#0b0a09"><meta name="color-scheme" content="dark"><meta name="robots" content="noindex">
<link rel="icon" href="${env.SITE}/assets/icon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&display=swap">
<style>
  :root { --ground: #0b0a09; --line: rgba(244, 239, 230, 0.12); --line-strong: rgba(244, 239, 230, 0.24); --ink: #f4efe6;
    --ink-2: #bdb4a8; --ember: #ff4a1c; --ember-hi: #ff6a3d; --on-ember: #170a05; --ease-out: cubic-bezier(0.23, 1, 0.32, 1); color-scheme: dark; }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; -webkit-tap-highlight-color: transparent; }
  body { margin: 0; min-height: 100svh; background: var(--ground); color: var(--ink); font: 17px/1.6 "Archivo", "Helvetica Neue", Arial, sans-serif; -webkit-font-smoothing: antialiased; }
  main { max-width: 640px; margin: 0 auto; padding: calc(28px + env(safe-area-inset-top, 0px)) max(20px, env(safe-area-inset-right, 0px)) calc(56px + env(safe-area-inset-bottom, 0px)) max(20px, env(safe-area-inset-left, 0px)); }
  .brand { display: inline-flex; align-items: center; gap: 12px; color: var(--ink); text-decoration: none; font-stretch: 125%; font-weight: 800; font-size: 14px; letter-spacing: 0.2em; text-transform: uppercase; }
  .brand svg { width: 24px; height: 24px; fill: var(--ember); }
  h1 { font-stretch: 125%; font-weight: 800; text-transform: uppercase; font-size: clamp(32px, 8vw, 52px); line-height: 0.95; margin: clamp(56px, 14vh, 120px) 0 24px; text-wrap: balance; }
  p { margin: 0 0 16px; color: var(--ink-2); max-width: 56ch; text-wrap: pretty; }
  b { color: var(--ink); font-weight: 700; }
  a { color: var(--ink); text-decoration-color: var(--line-strong); text-underline-offset: 4px; transition: color 0.2s, text-decoration-color 0.2s; }
  a, button { touch-action: manipulation; }
  :focus-visible { outline: 2px solid var(--ember); outline-offset: 3px; }
  button { font: inherit; font-size: 13px; font-weight: 700; font-stretch: 112%; letter-spacing: 0.16em; text-transform: uppercase;
    background: var(--ember); color: var(--on-ember); border: 0; border-radius: 2px; min-height: 52px; padding: 0 26px; cursor: pointer;
    -webkit-user-select: none; user-select: none; transition: background-color 0.2s, transform 0.16s var(--ease-out); }
  button:active { transform: scale(0.97); background: var(--ember-hi); }
  form { margin: 28px 0 0; }
  .list { list-style: none; padding: 0; margin: 28px 0; border-top: 1px solid var(--line); }
  .list li { padding: 20px 0; border-bottom: 1px solid var(--line); color: var(--ink-2); }
  .list form { margin-top: 14px; }
  .list button { min-height: 44px; padding: 0 18px; background: transparent; color: var(--ink); border: 1px solid var(--line-strong); }
  .list i { font-style: normal; color: var(--ember-hi); }
  @media (hover: hover) and (pointer: fine) {
    a:hover { color: var(--ember-hi); text-decoration-color: var(--ember-hi); }
    button:hover { background: var(--ember-hi); }
    .list button:hover { background: transparent; border-color: var(--ember); color: var(--ember-hi); }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style></head>
<body><main><a class="brand" href="${env.SITE}"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M2 21.5c6.5-.6 11-3.8 14-9.5 2.4 4.6 6.6 8.4 14 9.5-7.6 2.3-11.8 1.3-14-1.8-3 3.2-7.4 4-14 1.8z"/></svg>CampSwoop</a>
<h1>${esc(title)}</h1>${body}</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

function notFoundPage(env) {
  return page(env, "Link not found", `<p>This link doesn't work. It may be mistyped or from an alert that has ended.</p>${againLink(env)}`, 404);
}

function stopForm(watch, label) {
  return `<form method="post" action="/stop"><input type="hidden" name="w" value="${esc(watch.id)}">` +
         `<input type="hidden" name="t" value="${esc(watch.token)}"><button type="submit">${esc(label)}</button></form>`;
}

function againLink(env, label = "Sign up again") {
  return `<p><a href="${env.SITE}">${esc(label)}</a></p>`;
}

// --- Helpers ---------------------------------------------------------------------

async function findWatch(env, params) {
  const id = params.get("w") || "", token = params.get("t") || "";
  if (!/^[\w-]{6,40}$/.test(id) || !token) return null;
  const watch = await env.DB.prepare("SELECT * FROM watches WHERE id = ?").bind(id).first();
  return watch && safeEqual(watch.token, token) ? watch : null;
}

function setStatus(env, id, status) {
  return env.DB.prepare("UPDATE watches SET status = ?, updated = ? WHERE id = ?").bind(status, new Date().toISOString(), id).run();
}

function authorized(request, env) {
  const given = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  return Boolean(env.API_TOKEN) && safeEqual(given, env.API_TOKEN);
}

function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

function corsHeaders(request, env) {
  // The site itself, with or without www, and over http until GitHub Pages enforces https.
  const origin = request.headers.get("Origin") || "";
  const host = new URL(env.SITE).host;
  const allowed = ["https", "http"].flatMap(scheme => [`${scheme}://${host}`, `${scheme}://www.${host}`]);
  return allowed.includes(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
}

function withCors(response, request, env) {
  const result = new Response(response.body, response);
  for (const [name, value] of Object.entries(corsHeaders(request, env))) result.headers.set(name, value);
  return result;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function todayEastern() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date()); // YYYY-MM-DD
}

function parseDay(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  return !isNaN(date) && date.toISOString().startsWith(text) ? date : null;
}

const daysBetween = (a, b) => Math.round((b - a) / 86400e3);
const clamp = (n, low, high) => Math.min(high, Math.max(low, n));
const dayName = text => new Date(`${text}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).replace(",", "");

function describeStay(watch) {
  const nights = daysBetween(parseDay(watch.check_in), parseDay(watch.check_out));
  return `${dayName(watch.check_in)} – ${dayName(watch.check_out)}, ${watch.check_out.slice(0, 4)} (${nights} night${nights === 1 ? "" : "s"})`;
}

function shortDates(watch) {
  const month = text => new Date(`${text}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  const day = text => Number(text.slice(8, 10));
  return month(watch.check_in) === month(watch.check_out)
    ? `${month(watch.check_in)} ${day(watch.check_in)}–${day(watch.check_out)}`
    : `${month(watch.check_in)} ${day(watch.check_in)}–${month(watch.check_out)} ${day(watch.check_out)}`;
}

function rig(watch) {
  return watch.camping === "any" ? "any site" : CAMPING[watch.camping] + (watch.length ? `, ${watch.length} ft` : "");
}

function randomId(bytes) {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function esc(text) {
  return String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function decodeEntities(text) {
  return text.replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos|#39);/gi, (_, code) => {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[code.toLowerCase()];
    if (named) return named;
    return String.fromCodePoint(code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10));
  });
}
