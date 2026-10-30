# Hub user reporting — deferred discussion

## Status
The user asked to log this idea for future addition and return to it later.
No implementation, tracking activation, or scheduled work is approved.
The scope below records recommendations, not settled requirements.

## Goal and context
Understand activity within Hub by individual user, with daily, weekly, monthly,
and custom date-range reporting. Answer who uses Hub, which modules they use,
and what actions they perform.

Code inspection found existing signed-in staff identity and separate audit
records in some modules, including SepScope approvals, correspondence access,
and sales-record edits. It did not identify a unified Hub-wide usage log.
Existing records may support partial historical reporting, but must not be
presented as complete historical usage or used to invent past sessions.

## Recommended first phase
- Active days per user, module visits, meaningful actions, and last activity.
- One report row per user, filtered by date, module, and action type.
- Click through to a timestamped user timeline, with authorized links to
  associated records such as invoices.
- Example meaningful actions: pushing quotes, exporting reports, reviewing
  inspections, and purchasing actions. Distinguish attempts, successes, and
  failures rather than equating clicks with completed work.
- Reuse trustworthy existing audit evidence where possible; instrument missing
  events going forward and clearly label the coverage start date.

## Optional later phase: active time
Estimate active time only if it answers a specific operational question.
An open tab does not prove active work. Pause after inactivity, exclude hidden
or background tabs, and avoid counting simultaneous tabs twice. Label time as
an estimate rather than a precise timesheet or productivity measurement.
Session counts and sign-in reporting could be additional views, but are not
approved requirements.

## Reporting semantics and safeguards
- Separate staff interactions from background polling, scheduled scans,
  automated jobs, and system actions. Those must not inflate employee usage.
- Attribute activity to the authenticated staff identity rather than trusting
  a client-supplied user identifier.
- Usage is not productivity: fewer clicks can mean more efficient work.
  Prefer adoption and workflow analysis over simplistic employee rankings.
- Recommend administrator-only reporting, transparent notice to staff, and a
  defined retention period.
- Do not record keystrokes or unnecessarily copy customer data, message bodies,
  or sensitive content into analytics.
- Preserve the distinction between ordinary usage analytics and reliable
  business-action audit records.

## Decisions left for later
Which modules/actions matter most; who can view the report; retention;
reporting timezone; whether active-time estimates are useful; export needs;
and the acceptable amount of historical backfill from existing audit sources.

## Next discussion
Start with active days, module visits, meaningful actions, and the per-user
timeline. Evaluate active-time tracking separately rather than assuming it
belongs in the first release.
