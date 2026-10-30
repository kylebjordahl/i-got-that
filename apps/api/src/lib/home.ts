import { sitePage } from './site-page.js';

/**
 * The public homepage at the bare domain. Google's OAuth verification needs a
 * homepage on the app's domain that says what the app does and links to the
 * privacy policy, which a redirect into the sign-in-walled web app isn't, so
 * `/` serves this and links on to `/app/`. Keep it in step with the Privacy
 * Policy when what the app does with Google Calendar changes.
 */
export function homePage(): string {
  return sitePage({
    title: 'I Got That: family logistics, handled',
    description:
      'One shared calendar for the whole family. Every handoff owned, nothing dropped.',
    css: `
  .hero { padding: 24px 0 8px; }
  .hero img { width: 72px; height: 72px; border-radius: 16px; display: block; margin-bottom: 16px; }
  .hero h1 { font-size: 2.4rem; margin: 0 0 8px; letter-spacing: -0.02em; }
  .lede { font-size: 1.15rem; color: var(--muted); margin: 0 0 24px; }
  .cta { display: inline-block; background: var(--accent); color: var(--bg); text-decoration: none;
    font-weight: 600; padding: 12px 22px; border-radius: 999px; }
  .features { list-style: none; padding: 0; display: grid; gap: 12px; }
  .features li { background: var(--card); border-radius: 12px; padding: 14px 16px; }
  .features strong { display: block; }
  footer { margin-top: 48px; border-top: 1px solid var(--card); padding-top: 16px; }`,
    body: `<section class="hero">
<img src="/app/assets/assets/images/app_icon.png" alt="" onerror="this.remove()">
<h1>I Got That</h1>
<p class="lede">One shared calendar for the whole family. Every handoff owned, nothing dropped.</p>
<a class="cta" href="/app/">Open I Got That</a>
</section>

<h2>What it does</h2>
<p>I Got That (IGT) coordinates the logistics of a busy family. It pulls together the calendars your
family already lives by (school, sports, activities, and each parent's own calendar), builds one
schedule per person, and turns that schedule into the jobs that need an owner: the drop-off, the
pickup, the recital someone needs to attend.</p>
<ul class="features">
<li><strong>One calendar per person</strong>Subscribe to school and team calendars and connect your own. IGT combines
them into a unified calendar for each family member, applying the rules you set (no school on a
holiday, a late start on Wednesdays).</li>
<li><strong>Tasks that need an owner</strong>Events that need covering become drop-off, pickup, or attendance tasks,
following the task rules you set. A caretaker claims one with a tap, or your assignment rules hand it
out automatically.</li>
<li><strong>Back on your own calendar</strong>What you've claimed is written to the calendar you already use, such as
Google Calendar or iCloud (with travel time on Apple calendars), so your day shows the full picture.
Plans you add there yourself count too.</li>
<li><strong>Nothing silently dropped</strong>When a feed changes in a way IGT can't place, or two plans collide, it
asks instead of guessing, and reminds whoever needs to decide.</li>
</ul>

<h2>How IGT uses Google Calendar</h2>
<p>You can sign in with Google and connect Google Calendar. Signing in uses your Google account's
email address and account identifier to identify you. Connecting Google Calendar lets IGT:</p>
<ul>
<li>list your calendars, so you can pick which ones IGT uses;</li>
<li>read events from the calendars you choose as inputs;</li>
<li>read only the busy times from calendars you mark as busy-only;</li>
<li>create, update, and remove the events IGT manages on the one calendar you choose as a target, and
read the events you add to that calendar yourself so they're taken into account.</li>
</ul>
<p>IGT doesn't sell your data or use it for advertising, and its
use of information received from Google APIs adheres to the
<a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>,
including the Limited Use requirements. The <a href="/legal/privacy">Privacy Policy</a> has the details.</p>

<footer>
<a href="/legal/privacy">Privacy Policy</a> · <a href="/legal/terms">Terms of Service</a> ·
<a href="mailto:privacy@notio.dev">privacy@notio.dev</a><br>
I Got That is operated by Notio LLC.
</footer>`,
  });
}

/** The homepage as a response (shared by handler.fetch and the local-dev `/` route). */
export function homeResponse(): Response {
  return new Response(homePage(), {
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
