# Privacy Policy

Last updated: October 30, 2026

I Got That ("IGT", the "Service") is a family-logistics app. It combines your family's calendars into one schedule per person, turns that schedule into tasks such as drop-offs and pickups, and writes the tasks people claim back to their own calendars. IGT is operated by Notio LLC ("we", "us"). This policy explains what information the Service handles, why, who else touches it, and the choices you have.

**We do not sell your data, and we never will.** We do not share it for advertising, we do not show ads, and we do not use your data to train AI models.

## Information we collect

### Account information

- **Email address.** When you sign in with a magic link, or with Apple or Google, we receive your email address. We use it as your account identifier and to send sign-in links. If you use Apple's "Hide My Email", we receive only the relay address.
- **Sign-in identifiers.** Apple and Google give us a stable account identifier, which we store so that you can sign in again. The sign-in screens may also offer us your name (and, for Google, your profile photo), but we do not store either.
- **Sessions.** When you sign in we create a session token. Sessions expire after 30 days or when you sign out.

### Family information you enter

- The members of your family as you name them (for example "Mom" or "Sam"), each member's role (caretaker, admin, or someone who needs a caretaker), and a display color.
- A home location for a member, if you add one, including its map coordinates when your device can look them up.
- Rules you set for scheduling, tasks, and assignments, and your answers to the questions the app asks (pending decisions, conflicts, and task claims).
- Email addresses you enter for other people: family members you invite, addresses that should receive calendar invitations, and school contacts for absence notices.

Your family information may describe children. Only an adult account holder can enter it (see "Children" below).

### Calendar information

IGT only works with calendars you connect. Depending on what you set up, this includes:

- **Calendar feeds** (iCal/ICS subscription URLs, such as a school or team calendar). We store the URL and fetch it periodically.
- **Connected calendar accounts** (Google Calendar, iCloud, or another CalDAV server). We store the credential the provider issues: an OAuth refresh token for Google, or the username and app-specific password you enter for iCloud or CalDAV. Passwords and tokens are encrypted at rest. The API never returns them to the app, and other family members cannot see them.
- **Events from calendars you choose to read.** This means each event's title, time, location (and coordinates, when present), and description. The descriptions of events from calendars you read are used only to match your rules. They are not shown in the app or copied to other calendars.
- **Free/busy information.** For a calendar shared with you as "free/busy only", we read only the busy time ranges, never event details.
- **Events on your target calendar.** If you connect a calendar for IGT to write to, we also read back events that you add there yourself, so they can count in your family's schedule. For these events IGT also keeps the description and shows it to your family in the app, but does not copy it anywhere else.

### Device and usage information

- **Push notification tokens.** If you allow notifications on iOS, we store your device's Apple Push Notification service token, together with your device's time zone, which build of the app it is, and your notification schedule settings.
- **Location search.** When you search for a place in the iOS app, your device sends the search to Apple Maps. We store the result you pick (its name, address, and coordinates). We do not track your device's location.
- **Operational data.** For each API request we record its route pattern, method, status, duration, and the kind of client (web or app). These records contain no user or family identifiers, and we keep them for up to 90 days. Our hosting provider processes your IP address to deliver requests, and keeps short-lived request and error logs, which can include request paths and account and record identifiers.

### Cookies

The web app sets `igt_session`, which keeps you signed in. During Apple or Google sign-in it also sets a short-lived security cookie (`igt_apple_oauth` or `igt_google_oauth`) that expires after 10 minutes. These cookies are HttpOnly and are used for nothing else. We use no advertising or third-party analytics cookies.

## How we use information

We use the information above only to provide and maintain the Service:

- to sign you in and keep your account secure;
- to build each family member's unified calendar from the feeds and calendars you connect, apply your rules, and generate tasks;
- to write the events you've asked for to your target calendar, and to send calendar invitations to addresses that have confirmed they want them;
- to send sign-in links, address verification emails, and the notifications and digests you've turned on;
- to estimate travel time between events from their coordinates. This calculation runs on our servers; no routing service is involved.
- to diagnose failures, prevent abuse, and keep the Service running.

We do not use your information for advertising, profiling, or any purpose unrelated to the features you use.

## Google user data

IGT can sign you in with Google and connect your Google Calendar. When you connect Google, we request these permissions. Signing in with Google asks for them too, and connects your Google Calendar in the same step.

- **Your identity** (`openid`, `email`, `profile`). We use this to sign you in and link the Google account to your IGT account. We store only your Google account identifier and email address.
- **See and edit events on your calendars** (`calendar.events`). This lets IGT read events from the calendars you choose as inputs, and create, update, and delete the events IGT manages on the calendar you choose as a target.
- **See your calendars** (`calendar.readonly`). This lets IGT list your calendars so that you can pick which ones to use, and read events from calendars you choose as inputs.
- **See free/busy information** (`calendar.freebusy`). This lets IGT read busy time ranges from calendars you've chosen to treat as busy-only.

How Google user data is used and shared:

- Events read from Google Calendar are used only to build the schedules and tasks described above. As part of how the Service works, they are visible to the members of the family you added them to.
- Events are written only to calendars you chose, and while the calendar stays connected, IGT removes them when it no longer needs them there. If you set up IGT to write to a non-Google calendar (such as iCloud) or to send calendar invitations by email, the relevant events are transferred there at your direction.
- We never sell Google user data, use it for advertising, or use it to train AI or machine-learning models.
- People at Notio LLC do not read your Google user data unless you ask us to (for example, for a support request), we need to for security reasons such as investigating abuse, the law requires it, or the data has been aggregated and anonymized for internal operations.

IGT's use and transfer to any other app of information received from Google APIs will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

You can disconnect a Google account in the app at any time. When you do, or when you delete your IGT account, we ask Google to revoke the refresh token we hold for that account (which also ends any access tokens issued from it) and delete our copy. Disconnecting pauses the calendars read through that account. Events already imported stay in your family's schedule until you remove those calendars or the family, and events IGT already wrote to that account's calendars stay there. If you signed in with Google without connecting a calendar, removed Google as a sign-in method, or if revocation fails, you can remove IGT's access from your [Google Account permissions page](https://myaccount.google.com/permissions).

## How information is shared

We share information only in the following ways:

- **Within your family.** Members of a family can see that family's schedules, tasks, and who has claimed what, according to their role. The credentials you connect, and which calendar you choose as your target, stay private to you, though events you add to that calendar appear in your family's schedule.
- **With calendars and people you choose.** IGT writes events to the target calendars you connect. It emails calendar invitations only to addresses that have confirmed, through a link we send them, that they want to receive invitations. You can stop invitations to an address with the unsubscribe link in any invitation email. Absence notices to a school are composed by IGT but sent from your own email app, and only if you choose to send them.
- **With service providers.** We use these providers to run the Service, and only for that purpose: Cloudflare, Inc. hosts our application, database, and logs, and sends our email; Apple Inc. provides Sign in with Apple, push notifications, and Apple Maps place search; Google LLC provides Sign in with Google and the Google Calendar API. The calendar servers you connect (Google, iCloud, or others) also receive the requests IGT makes on your behalf.
- **For legal reasons.** We share information when required by law, or to protect the rights, safety, or property of our users, the public, or Notio LLC.
- **If the business changes hands.** If Notio LLC is part of a merger or acquisition, your information may transfer to the successor. The successor remains bound by this policy, including the commitment not to sell your data.

## Retention and deletion

We keep your information until you delete it, the family it belongs to, or your account. We do not currently delete past events automatically.

- **Deleting your account** (Me → Delete account) removes your login, your sessions, your connected calendar accounts and their credentials, and your email addresses from our sign-in, invitation, and recipient records (except where another family still sends invitations to that address). It also removes every family that no one else can sign in to, along with everything in those families. In a family that others still use, your member entry stays on the roster without a login, and anything connected through your calendar accounts is removed.
- **Deleting a family** (admins only) removes its members, feeds, events, tasks, and rules.
- **Events IGT has already written** to your own calendars are not removed when you delete your account or a family. You can delete them in your calendar app.
- **Suppression records.** If an address has unsubscribed from invitations, we keep a record of that so that it stays unsubscribed.
- **Backups.** Deleted data can remain in our database provider's point-in-time recovery backups for up to 30 days before it ages out.

## Security

Connection credentials are encrypted with envelope encryption, and the keys are held separately from the database. All traffic to the Service uses HTTPS. On iOS and Android, the app keeps your session in the device's secure storage (Keychain or Keystore). On the web, the session is kept in an HttpOnly cookie that page scripts cannot read. No method of storage or transmission is perfectly secure, but we work to protect your information and will notify you as required by law if a breach affects it.

## Children

IGT accounts are for adults: you must be 18 or older to create one. Information about children is entered by their parents or guardians to coordinate their care, and children do not use the Service directly. We do not knowingly collect personal information directly from children under 13. If you believe a child has created an account, contact us and we will delete it.

## Your choices and rights

- You can view and edit your family's information in the app. Admins can change family structure, feeds, and roles.
- You can disconnect any calendar account, remove any feed, turn off or change notifications, and stop calendar invitations at any time.
- You can delete your account and data in the app, or by emailing us.
- Depending on where you live (for example, California or the EU/UK), you may have the right to access, correct, delete, or port your personal information, or to object to certain processing. To make a request, email [privacy@notio.dev](mailto:privacy@notio.dev). We will respond within the time the law requires, and we won't treat you differently for exercising these rights.

## Where data is processed

Notio LLC is based in the United States. Our service providers may process data in the United States and in other countries where they operate.

## Changes to this policy

When we change this policy, we will post the new version at this address and update the date at the top. If a change affects how we use information you've already given us, including Google user data, we will notify you in the app or by email and ask for your consent where required before the change takes effect.

## Contact

Notio LLC, [privacy@notio.dev](mailto:privacy@notio.dev)
